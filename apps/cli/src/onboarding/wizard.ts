import {
  NATIVE_PROMPT_BACK,
  type NativePromptEscape,
  type NativePromptFlow,
  type NativePromptOption,
} from '../render/tui/native-prompt-channel.js';
import { inertLegendText, keyToken } from '../render/tui/legend.js';
import { authorLine } from '../render/tui/run-card-model.js';
import { foldLineSeparators } from '../popups/frame-model.js';
import type { ProviderStore } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';

import { runProviderCommand } from '../commands/provider.js';
import type { PreparedConfigWrite } from '../config/write.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  providerDisplayName,
  providerEndpointOrigin,
  providerKeyEnvVar,
  validateProviderKey,
  type ProviderKeyValidation,
  type ProviderResolver,
} from '../engine/providers.js';
import type { FramedDone } from '../home/framed-flow.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import {
  FIRST_RUN_NOTE_TITLE,
  SAVED_UNCONFIRMED,
  SETUP_NEXT_STEP,
  UNKNOWN_KEY_HOST,
  keyCheckText,
  keyStepNote,
  setupSkippedNotice,
  type SetupSurface,
} from './setup-notes.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';

/**
 * The first-run onboarding setup (workstream **2.5.G S8**): it turns a KEY-LESS Home into a working chat: pick a provider → paste a
 * **hidden** API key → check it with the provider once → store it in the OS keychain, with a keychain-write fallback that names the environment
 * variable (the key is **NEVER** written to disk), then choose the provider's starter model as the default.
 *
 * It runs on the host's native prompt channel ({@link runNativeSetup}). On the Home its steps are the steps of the `/providers` popup
 * (`native.stages`, ADR-0148 §1, ADR-0146 §6): `Provider · Key · Done`; `Esc` on the first step skips (its legend says `Esc skip for now`), `Esc`
 * steps back from the key, from the key's check (which it aborts, O6) and from the choices after a failed check, `Ctrl+C` leaves, and the result
 * is a persistent Done step. In a stand-alone chat's pre-chat mount, which has
 * no popup slot, they are the card they always were, and the result is the card's last note. (The `@clack/prompts` path it once had was the
 * Home's injected test seam only, and was deleted in MVP-11 unit 6.)
 *
 * SECURITY (this captures a live API key):
 *  - The key is read through a masked prompt (never an argv flag, never echoed) and held only in memory, in the channel's private editor, never
 *    in a snapshot, cleared on `Esc`, on a step back and on any resize.
 *  - Before it is stored, it is sent LIVE to the provider ONCE (the bounded, key-redacted {@link validateProviderKey} `maxTokens:1` ping against
 *    the provider's STARTER model) to verify it; the setup says so before the key is pasted and while the request runs, naming the host of the
 *    origin that receives it (G20). The key crosses the network only to its own provider, over the adapter's own transport. In the popup the
 *    pre-selected `Retry the check` (which sends it again) is GUARDED, so a held `Enter` does not re-send it at the key's repeat rate.
 *  - It is then handed to the OS keychain. On a validation FAILURE the user may consciously "save it anyway": the key is then stored UNVERIFIED
 *    and the result says so (never claiming a verification we didn't do).
 *  - No part of the key is ever shown. Nothing is written to a file, a log, an error or a report.
 *  - The keychain-unavailable fallback names the env var to set (as a variable name, no shell command), NEVER the key, and NEVER a plaintext
 *    file (the deliberate "no silent plaintext fallback" of `providerSetKey`).
 */

/** `an Anthropic`, `a Google Gemini`: the article a sentence needs before a provider's display name (the four known names). */
function withArticle(name: string): string {
  return /^[AEIOU]/u.test(name) ? `an ${name}` : `a ${name}`;
}

/**
 * The full scrub of a surface with a chord step (ADR-0145 §5), for every string of the setup that a provider, an endpoint, a variable or a
 * catalogue wrote (a display name, a destination, a host, a model): the run cards' author-text floor (secrets scrubbed, folded, host glyphs
 * blanked, answer chords replaced), then key tokens and legend separators made inert, then the line separators folded to a space (every such
 * string is one line of a step). The popups' `scrubPopupText` and the frame's fold, composed here because the popups' text module is loaded
 * lazily and the setup is on the Home's first paint (`popups/lazy-load.test.ts`).
 */
export function scrubSetupText(text: string): string {
  return foldLineSeparators(inertLegendText(authorLine(text)));
}

/** What the default-model write came to, as the setup reads it. */
export type OnboardingDefaultResult =
  | { readonly kind: 'saved'; readonly durability: 'confirmed' | 'unconfirmed' }
  | { readonly kind: 'ephemeral' }
  | { readonly kind: 'cancelled' };

/** The prompts of one step of the setup popup (`framedFlow(…).at(i)`), or the card's own flow. */
export type SetupPrompts = Pick<NativePromptFlow, 'busy' | 'select' | 'password'>;

/**
 * The steps of the Home's `/providers` popup (ADR-0148 §1, ADR-0146 §6), when the setup is drawn as one: the prompts of the `Provider` step,
 * those of the `Key` step (the key, its check, the choices after a failed check) and the persistent Done step. Absent on a card (the stand-alone
 * chat's pre-chat mount, which has no popup slot), where every prompt is the card's and the result is its last note.
 */
export interface SetupStages {
  readonly provider: SetupPrompts;
  readonly key: SetupPrompts;
  /**
   * The key prompt itself where its `Esc` is not the key step's step back to the provider: on the automatic first run whose FIRST prompt it
   * is (a custom endpoint refused the environment key, so the setup asks for a key at once), its step back is the skip and its legend says so
   * (`Esc skip for now`). Absent ⇒ {@link key}. The check and the choices after a failed check are always {@link key}'s.
   */
  readonly keyPrompt?: SetupPrompts;
  readonly done: (done: FramedDone) => Promise<void>;
}

/** What the native setup did, for the coordinator that opened it. */
export type NativeSetupResult =
  /** `Esc` stepped back from the key step and the setup had no step before it (the caller chose the provider): the caller asks again. */
  | { readonly kind: 'back' }
  /**
   * The person skipped the setup: in the popup `Esc` on `Which provider?` (its first step) or `Skip setup` after a failed check; on a card
   * `Esc` anywhere, as it always was.
   */
  | { readonly kind: 'skipped' }
  /** The flow was left (`Ctrl+C`, or the host stopped it) before anything was stored: in the popup, never a skip. */
  | { readonly kind: 'cancelled' }
  /**
   * The setup reached its end and said so itself (the Done step, or the card's last note): a key `stored`, or a store that failed. `notice` is
   * a line for the host when the popup's Done step could not be shown (the flow was cancelled after the key was stored).
   */
  | { readonly kind: 'finished'; readonly stored: boolean; readonly notice?: string };

export interface NativeOnboarding {
  readonly flow: NativePromptFlow;
  readonly signal: AbortSignal;
  readonly assertAdmitting: () => void;
  readonly endpointContext: (id: ProviderId) => string;
  /** Only a first usable-source setup chooses a starter; key maintenance preserves model preferences. */
  readonly selectStarterDefault?: boolean;
  readonly surface?: SetupSurface;
  /** The popup's steps (the Home); absent ⇒ a card (a stand-alone chat). */
  readonly stages?: SetupStages;
}

/** The setup's ports besides its prompts ({@link NativeOnboarding}): the keychain-write path, the resolver, the default-model writer. */
export interface OnboardingDeps {
  readonly workOwner?: SessionWorkOwner;
  readonly initialProvider?: ProviderId;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly resolver: ProviderResolver;
  readonly io: CliIo;
  /** Persist the NEXT session's default model AND its `provider` (ADR-0059 — authoritative at pick time) via the
   *  Home's config target. The setup sets the CHOSEN provider's starter model (`KNOWN_PROVIDERS[id].starterModel`) so the first chat binds a
   *  model whose key was just stored, and persisting the provider means that first chat skips id inference. */
  readonly writeDefaultModel: (
    modelId: string,
    provider: ProviderId,
    assertAdmitting?: () => void,
    /**
     * The setup run's own view of the write the host prepares (MVP-11 unit 6, W7 item 5): a global config this run created a moment before
     * and that nobody changed since loses nothing a person wrote, so its rewrite notice is not drawn. The host passes its prepared write
     * through it before it publishes; absent ⇒ as prepared.
     */
    runWrite?: (prepared: PreparedConfigWrite) => PreparedConfigWrite,
  ) => unknown;
  /**
   * LIVE-validate a just-entered key (2.5.G S8) — injected for tests (no network). Absent ⇒ the real bounded,
   * key-redacted {@link validateProviderKey} probe against the provider's `starterModel`. The setup uses the
   * result's `reason` to branch the retry UX (auth → re-enter; network → retry the check). A resolver with no
   * adapter (a test stub) validates as `ok` so the flow never blocks on an un-probeable provider. `signal` aborts when the check is
   * abandoned (the person stepped back out of it with `Esc`, or left the setup): the check should stop, and its answer is never read.
   */
  readonly validate?: (
    id: ProviderId,
    key: string,
    signal?: AbortSignal,
  ) => Promise<ProviderKeyValidation>;
}

/**
 * The key prompt's validator: it rejects an empty or whitespace-only key. The masked field draws its own fixed sentence for a rejected value
 * (`A valid value is required.`), so the reason is drawn by no surface and names no key.
 */
const keyRequired = (value: string): string | undefined =>
  value.trim() === '' ? 'An API key is required.' : undefined;

/**
 * The native setup (see the module header), with what it did. A cancellation that is the flow's own (its signal's reason) is `cancelled`; any
 * other fault becomes the fixed `Provider setup failed.` (nothing of its cause reaches a host's words). Every STORAGE outcome ends cleanly
 * (keychain-unavailable → env-var guidance; any other storage fault → a generic note); none rethrows.
 */
export async function runNativeSetup(
  deps: OnboardingDeps,
  native: NativeOnboarding,
): Promise<NativeSetupResult> {
  try {
    return await runNative(deps, native);
  } catch (cause) {
    if (native.signal.aborted && cause === native.signal.reason) return { kind: 'cancelled' };
    throw new Error('Provider setup failed.');
  }
}

/** `global` is read only by `provider list --json`; `set-key` never touches it — a throwaway (the setup is always interactive). */
const THROWAWAY_GLOBAL = {
  json: false,
  color: false,
  cwd: process.cwd(),
  configPath: undefined,
  verbosity: 'normal',
} as const;

/**
 * Store via the TESTED providerSetKey path (keychain.set + the provider row + the keychain-ref, secret-free). Its one stdout line is
 * suppressed (a silent io): the setup says what happened itself.
 */
function silentIo(io: CliIo): CliIo {
  return {
    env: io.env,
    stdoutIsTty: false,
    stdinIsTty: io.stdinIsTty,
    stdin: io.stdin,
    writeOut: () => undefined,
    writeErr: () => undefined,
    writeOutAcknowledged: () => Promise.resolve(),
    writeErrAcknowledged: () => Promise.resolve(),
  };
}

/**
 * Distinguish the EXPECTED keychain-unavailable failure (recoverable → env-var guidance) from an UNEXPECTED fault (e.g. a db write).
 * `providerSetKey` writes to the keychain FIRST, so a keychain-unavailable failure persists NOTHING; mislabeling a *post*-`keychain.set` fault
 * as "keychain unavailable, key not saved" would LIE. `runProviderCommand` wraps `KeychainUnavailableError` in a `CliError(cause)`; the bare
 * `instanceof` is a DEFENSIVE fallback for a future direct caller. The raw error is never rendered.
 */
function isKeychainDown(err: unknown): boolean {
  return (
    err instanceof KeychainUnavailableError ||
    (err instanceof CliError && err.cause instanceof KeychainUnavailableError)
  );
}

/** The real key check: the bounded, key-redacted probe against the provider's starter model (a stub resolver with no adapter passes). */
function defaultValidate(
  deps: OnboardingDeps,
): (id: ProviderId, key: string, signal?: AbortSignal) => Promise<ProviderKeyValidation> {
  return async (id, k, signal) => {
    const adapter = deps.resolver.resolveProvider(id);
    // A NON-PRODUCTION path only: the real `createProviderResolver` returns an adapter for every `ProviderId`, so
    // this `undefined` branch is reachable ONLY by a test stub (`resolveProvider: () => undefined`). There it
    // can't probe, so it treats the key as ok to avoid blocking the scripted flow; in production every first-run
    // key is genuinely probed, so the "Verified and stored" copy is never shown for an un-probed key.
    if (adapter === undefined) return { ok: true, detail: 'skipped', reason: 'ok' };
    const owner = deps.workOwner;
    return validateProviderKey(
      adapter,
      k,
      KNOWN_PROVIDERS[id].starterModel,
      undefined,
      checkLifecycle(owner, signal),
    );
  };
}

/**
 * The key check's lifecycle under the session's work owner: the request stops when the session's work does, and when the check is abandoned
 * (`signal`: `Esc` stepped back out of it, or the setup was left). None without an owner (an ownerless embedding keeps its own contract).
 */
function checkLifecycle(
  owner: SessionWorkOwner | undefined,
  signal: AbortSignal | undefined,
): Parameters<typeof validateProviderKey>[4] {
  if (owner === undefined) return undefined;
  return {
    signal: signal === undefined ? owner.signal : AbortSignal.any([owner.signal, signal]),
    work: owner.work,
    assertAdmitting: owner.assertAdmitting,
  };
}

/** The hint of `Save it anyway · not verified`: how to verify the key later, on the surface where the doctor's deep tier is `[d]`. */
export const SAVE_ANYWAY_HINT = `not checked · verify later with /doctor, then ${keyToken('d')}`;
/** What the Done step of a key saved without a check says about it: not verified, and how to verify it (the doctor's deep tier). */
export const UNVERIFIED_KEY_LINE = `Not verified · check it later with /doctor, then ${keyToken('d')}`;

/** The choices after a failed check (a select's payload). */
interface RetryPrompt {
  readonly message: string;
  readonly options: readonly NativePromptOption[];
  readonly initialValue: string;
}

/**
 * Build the failed-key retry prompt. The options and the pre-highlighted (bare-Enter) one depend on the CAUSE, and a failed check is never
 * answered by a reflex `Enter` into an unverified key (ADR-0146 §6):
 *
 * - a TRANSIENT (`network`: offline, a timeout, rate limit, overloaded) failure puts `Retry the check` first and pre-selected: the same key
 *   is checked again, with nothing to paste, so a poor connection does not push toward saving it unverified. It SENDS the key again, so where
 *   the select can be guarded (`guardRecheck`: the popup, whose frames are acknowledged) it is: a held `Enter` (the one that submitted the key,
 *   still repeating) answers nothing, and a deliberate one counts after the lockout that runs from the moment the select appeared (S5);
 * - any other failure (a rejected key, a billing or account issue, an unexpected fault) puts `Enter a different key` first and
 *   pre-selected. It sends nothing (it opens the key step again, empty, whose `Enter` on an empty field is refused), so it is not guarded.
 *   `detail` (the setup's fixed word) is the neutral evidence: we do NOT assert "the key is bad" for the non-network case, since a 402/400
 *   may mean billing or a stale model rather than a wrong key.
 *
 * `Save it anyway · not verified` is never pre-selected and sits last but one, and `Skip setup` is last. Its hint names how to verify later:
 * the doctor's deep tier (`/doctor`, then `[d]`), which checks the stored key with the same request.
 */
function buildRetryPrompt(
  isTransient: boolean,
  displayName: string,
  detail: string,
  guardRecheck: boolean,
): RetryPrompt {
  const recheck: NativePromptOption = {
    value: 'recheck',
    label: 'Retry the check',
    ...(guardRecheck ? { guarded: true as const } : {}),
  };
  const enterDifferent = { value: 'retry', label: 'Enter a different key' };
  const saveAnyway = {
    value: 'continue',
    label: 'Save it anyway · not verified',
    hint: SAVE_ANYWAY_HINT,
  };
  const skipSetup = { value: 'skip', label: 'Skip setup' };
  return {
    message: isTransient
      ? `Couldn't reach ${displayName} to verify — you may be offline or it's busy (${detail}).`
      : `Couldn't verify your ${displayName} key (${detail}).`,
    options: isTransient
      ? [recheck, enterDifferent, saveAnyway, skipSetup]
      : [enterDifferent, saveAnyway, skipSetup],
    initialValue: isTransient ? 'recheck' : 'retry',
  };
}

/** The recovery after a setup that could not finish: a pointer to the way back in, in actions the host has. */
function nativeSetupRemedy(surface: SetupSurface | undefined): string {
  return surface === 'standalone-chat'
    ? 'Restart this chat to open provider setup, or run /doctor to check your setup.'
    : 'Open /providers to connect a key, or run /doctor to check your setup.';
}

/** The fixed words the setup shows for a failed check (never the provider's own text, which can echo the request). */
function failureWord(reason: ProviderKeyValidation['reason']): string {
  if (reason === 'auth') return 'authentication failed';
  if (reason === 'network') return 'network unavailable';
  return 'verification failed';
}

/** The first-run sentence (only on a genuine first run: no usable source before this setup). */
const FIRST_RUN_SENTENCE =
  'Connect a model provider to start chatting.\nYour key is stored in your OS keychain — never on disk.';

/**
 * Where the key step says the key goes (ADR-0146 §6, G20): the ORIGIN the resolver pinned for this provider's adapter (a stored custom endpoint
 * changes it; `providerEndpointOrigin`: an `https:` origin exactly, scheme and port included, the same words the doctor's deep-tier consent
 * uses), scrubbed, or a fixed phrase when the resolver cannot say (never the provider's known URL alone).
 */
export function keyDestinationHost(resolver: ProviderResolver, id: ProviderId): string {
  const origin = providerEndpointOrigin(resolver, id);
  const shown = origin === undefined ? '' : scrubSetupText(origin);
  return shown === '' ? UNKNOWN_KEY_HOST : shown;
}

/** How the setup ends when the person leaves it or skips it before anything was stored. */
type LeftSetup = Extract<NativeSetupResult, { readonly kind: 'back' | 'skipped' | 'cancelled' }>;

/** What one turn of the key step came to. */
type KeyOutcome =
  | { readonly kind: 'key'; readonly key: string; readonly verified: boolean }
  | { readonly kind: 'again' }
  | LeftSetup;

/** The parts of a native run every step reads. */
interface NativeRun {
  readonly deps: OnboardingDeps;
  readonly native: NativeOnboarding;
  /**
   * `back` in the popup (`Esc` on the first step skips, and steps back from the key and from the choices after a failed check, so `Ctrl+C`
   * alone leaves); `cancel` on a card (as it always was: `Esc` there skips).
   */
  readonly escape: NativePromptEscape;
  readonly admit: () => void;
}

async function runNative(
  deps: OnboardingDeps,
  native: NativeOnboarding,
): Promise<NativeSetupResult> {
  const run: NativeRun = {
    deps,
    native,
    escape: native.stages === undefined ? 'cancel' : 'back',
    admit: () => {
      deps.workOwner?.assertAdmitting();
      native.assertAdmitting();
      native.signal.throwIfAborted();
    },
  };
  run.admit();
  for (;;) {
    noteProviderStep(run);
    const provider = deps.initialProvider ?? (await chooseProvider(run));
    if (typeof provider !== 'string') return provider;
    const keyed = await keyStep(run, provider);
    if (keyed.kind === 'key') return await storeKey(run, provider, keyed.key, keyed.verified);
    // `Esc` on the key step goes back to the provider list, when the setup asked for the provider itself.
    if (keyed.kind !== 'back' || deps.initialProvider !== undefined) return keyed;
  }
}

/**
 * The note above the `Provider` step: the first-run sentence belongs to a genuine first run (`selectStarterDefault` is exactly "no usable
 * source before this setup"); a step back from the key step takes the key step's note away with it.
 */
function noteProviderStep(run: NativeRun): void {
  if (run.native.selectStarterDefault !== false)
    run.native.flow.note(FIRST_RUN_SENTENCE, FIRST_RUN_NOTE_TITLE);
  else if (run.native.stages !== undefined) run.native.flow.note('');
}

/** On a card, a way out of the setup says it was a skip, in its one line (the popup's host says it instead, as a notification). */
function cardSkip(run: NativeRun): Extract<NativeSetupResult, { readonly kind: 'skipped' }> {
  if (run.native.stages === undefined) run.native.flow.note(setupSkippedNotice(run.native.surface));
  return { kind: 'skipped' };
}

/** The way out of the setup that is not a skip: on a card it is one (`Esc` there always skipped); in the popup it is a cancel (`Ctrl+C`). */
function leaveSetup(
  run: NativeRun,
): Extract<LeftSetup, { readonly kind: 'skipped' | 'cancelled' }> {
  return run.native.stages === undefined ? cardSkip(run) : { kind: 'cancelled' };
}

/**
 * The `Provider` step: `Which provider?`. In the popup it is opened to step back, so the channel tells the two ways out apart: `Esc` there is
 * the skip of the setup (the first step's way back), and `Ctrl+C` leaves it with nothing skipped (S3). On a card `Esc` skips, as it always did.
 */
async function chooseProvider(
  run: NativeRun,
): Promise<ProviderId | Extract<LeftSetup, { readonly kind: 'skipped' | 'cancelled' }>> {
  const prompts = run.native.stages?.provider ?? run.native.flow;
  const picked = await prompts.select({
    message: 'Which provider?',
    options: KNOWN_PROVIDER_IDS.map((id) => ({
      value: id,
      label: KNOWN_PROVIDERS[id].displayName,
      hint: scrubSetupText(run.native.endpointContext(id)),
    })),
    escape: run.escape,
  });
  const provider =
    typeof picked === 'string' ? KNOWN_PROVIDER_IDS.find((id) => id === picked) : undefined;
  if (provider !== undefined) return provider;
  return picked === NATIVE_PROMPT_BACK ? { kind: 'skipped' } : leaveSetup(run);
}

/**
 * The `Key` step: what happens to the key (stored in the OS keychain, sent once to one host to check it), the masked prompt, the check, and the
 * choices after a failed check. `Esc` on the prompt steps back to the `Provider` step; on the choices it returns to the prompt.
 */
async function keyStep(
  run: NativeRun,
  provider: ProviderId,
): Promise<Exclude<KeyOutcome, { readonly kind: 'again' }>> {
  const prompts = run.native.stages?.key ?? run.native.flow;
  const words = {
    name: scrubSetupText(KNOWN_PROVIDERS[provider].displayName),
    host: keyDestinationHost(run.deps.resolver, provider),
  };
  for (;;) {
    run.admit();
    run.native.flow.note(keyStepNote(words.host));
    const raw = await (run.native.stages?.keyPrompt ?? prompts).password({
      message: `Paste your ${words.name} API key`,
      validate: keyRequired,
      escape: run.escape,
    });
    if (raw === NATIVE_PROMPT_BACK) return { kind: 'back' };
    if (typeof raw === 'symbol') return leaveSetup(run);
    // Trim incidental paste whitespace before storing, as `provider set-key` does; `keyRequired` rejected a whitespace-only value.
    const checked = await checkKey(run, prompts, provider, raw.trim(), words);
    if (checked.kind !== 'again') return checked;
  }
}

/** What a check `Esc` stepped back out of came to (O6): the key step again, its field empty. */
const STEPPED_BACK = Symbol('the key check was stepped back out of');

/** The check of one key and the choices after it failed, until a key is kept, the person asks for the key step again, or leaves. */
async function checkKey(
  run: NativeRun,
  prompts: SetupPrompts,
  provider: ProviderId,
  key: string,
  words: { readonly name: string; readonly host: string },
): Promise<KeyOutcome> {
  for (;;) {
    run.admit();
    const result = await checkOnce(run, prompts, provider, key, words);
    if (result === STEPPED_BACK) return { kind: 'again' };
    run.admit();
    if (result.ok) return { kind: 'key', key, verified: true };
    const choice = await prompts.select({
      ...buildRetryPrompt(
        result.reason === 'network',
        words.name,
        failureWord(result.reason),
        run.native.stages !== undefined,
      ),
      escape: run.escape,
    });
    const answered = afterFailedCheck(run, choice, key);
    // `undefined` is `Retry the check` (offered after a network failure only): the same check again with the SAME key, which this loop holds.
    if (answered !== undefined) return answered;
  }
}

/**
 * One check of `key`, drawn as the key step's wait (G20: the request is disclosed with its host). In the popup the wait steps back (O6): `Esc`
 * aborts THIS check through its own controller (the flow's signal is untouched, so `Ctrl+C` still leaves the setup), the check is told to stop,
 * and the result is {@link STEPPED_BACK}: whatever the aborted check answers later is never read, so it stores nothing. On a card `Esc` leaves
 * the setup, as it always did.
 */
async function checkOnce(
  run: NativeRun,
  prompts: SetupPrompts,
  provider: ProviderId,
  key: string,
  words: { readonly name: string; readonly host: string },
): Promise<ProviderKeyValidation | typeof STEPPED_BACK> {
  const stop = new AbortController();
  const back = run.native.stages === undefined ? undefined : { onBack: () => stop.abort() };
  prompts.busy(keyCheckText(words.name, words.host), back);
  try {
    return await runCheck(run, provider, key, stop.signal);
  } catch (cause) {
    if (stop.signal.aborted && !run.native.signal.aborted) return STEPPED_BACK;
    throw cause;
  }
}

/**
 * One check of `key`: the injected or real validator, retained by the work owner when there is one, observed against the flow's signal and
 * `stop` (the check abandoned), either of which also aborts the check itself.
 */
function runCheck(
  run: NativeRun,
  provider: ProviderId,
  key: string,
  stop: AbortSignal,
): Promise<ProviderKeyValidation> {
  const validate = run.deps.validate ?? defaultValidate(run.deps);
  const owner = run.deps.workOwner;
  const abandoned = AbortSignal.any([run.native.signal, stop]);
  const operation = () => validate(provider, key, abandoned);
  return observeValidation(
    owner === undefined ? operation() : owner.work.retainWork(operation),
    abandoned,
  );
}

/** What an answer to the choices after a failed check comes to; `undefined` for `Retry the check`. */
function afterFailedCheck(
  run: NativeRun,
  choice: string | symbol,
  key: string,
): KeyOutcome | undefined {
  if (choice === NATIVE_PROMPT_BACK || choice === 'retry') return { kind: 'again' };
  if (typeof choice === 'symbol') return leaveSetup(run);
  if (choice === 'skip') return cardSkip(run);
  if (choice === 'continue') return { kind: 'key', key, verified: false };
  if (choice !== 'recheck') throw new Error(`unexpected wizard choice: ${choice}`);
  return undefined;
}

/** What the setup reports at its end: the popup's Done step, or the card's last note (as it always was). */
interface Report {
  /** The card's note, under its title. */
  readonly card: { readonly message: string; readonly title: string };
  /** The popup's Done step. */
  readonly done: FramedDone;
  /** The popup host's line when the Done step could not be shown (the flow was already cancelled). */
  readonly interrupted?: string;
}

/** Say what the setup did: the Done step in the popup (the host's line when it cannot be shown), or the card's committed note. */
async function report(
  run: NativeRun,
  said: Report,
  stored: boolean,
): Promise<Extract<NativeSetupResult, { readonly kind: 'finished' }>> {
  const stages = run.native.stages;
  if (stages === undefined) {
    const flow = run.native.flow;
    if (flow.committedNote !== undefined) flow.committedNote(said.card.message, said.card.title);
    else flow.note(said.card.message, said.card.title);
    return { kind: 'finished', stored };
  }
  if (run.native.signal.aborted)
    return {
      kind: 'finished',
      stored,
      ...(said.interrupted === undefined ? {} : { notice: said.interrupted }),
    };
  await stages.done(said.done);
  return { kind: 'finished', stored };
}

/** Store the key (the tested `provider set-key` path, unchanged), then choose the starter default and report. */
async function storeKey(
  run: NativeRun,
  provider: ProviderId,
  keyToStore: string,
  verified: boolean,
): Promise<NativeSetupResult> {
  const { deps, native } = run;
  const displayName = providerDisplayName(provider);
  const name = scrubSetupText(displayName);
  let keyStored = false;
  const keychain: KeychainStore = {
    get: (account) => deps.keychain.get(account),
    set: (account, value) => {
      deps.keychain.set(account, value);
      keyStored = true;
    },
    delete: (account) => deps.keychain.delete(account),
  };
  const store: ProviderStore = {
    list: () => deps.store.list(),
    get: (rowName) => deps.store.get(rowName),
    upsert: (input) => {
      run.admit();
      return deps.store.upsert(input);
    },
    setKeychainRef: (rowName, ref) => {
      run.admit();
      deps.store.setKeychainRef(rowName, ref);
    },
    clearKeychainRef: (rowName) => {
      run.admit();
      deps.store.clearKeychainRef(rowName);
    },
  };
  // A key that was checked and answered is CONNECTED; a key the person chose to keep after a failed check is only SAVED: nothing may say a
  // connection that was never made (round 2, U3).
  const title = verified ? 'Connected' : 'Saved';
  const interrupted = `${name} key stored · setup was interrupted`;
  try {
    await runProviderCommand(
      { action: 'set-key', name: provider },
      {
        io: silentIo(deps.io),
        store,
        keychain,
        resolver: deps.resolver,
        readSecret: () => Promise.resolve(keyToStore),
        assertAdmitting: run.admit,
        global: THROWAWAY_GLOBAL,
      },
    );
    if (native.signal.aborted) {
      const message = `Your ${displayName} key was stored in the OS keychain. The default model was not saved.`;
      return await report(
        run,
        {
          card: { message, title },
          done: { message: `${title} · ${name}`, lines: ['The default model was not saved.'] },
          interrupted,
        },
        true,
      );
    }
    run.admit();
  } catch (err) {
    if (native.signal.aborted && err === native.signal.reason) {
      if (!keyStored) return { kind: 'cancelled' };
      const message = `Your ${displayName} key was stored in the OS keychain, but setup was interrupted. The default model was not saved.`;
      return await report(
        run,
        {
          card: { message, title },
          done: { message: `${title} · ${name}`, lines: ['The default model was not saved.'] },
          interrupted,
        },
        true,
      );
    }
    if (native.signal.aborted) throw err;
    if (deps.workOwner !== undefined) {
      deps.workOwner.failure(err);
      deps.workOwner.assertAdmitting();
    }
    return await reportStoreFault(run, provider, name, isKeychainDown(err));
  }
  return await chooseStarter(run, provider, verified);
}

/** The key could not be stored: the keychain was unreachable (the variable is the way to use it anyway), or the store failed otherwise. */
async function reportStoreFault(
  run: NativeRun,
  provider: ProviderId,
  name: string,
  keychainDown: boolean,
): Promise<NativeSetupResult> {
  const variable = providerKeyEnvVar(provider);
  if (keychainDown) {
    const unreachable = "Couldn't reach your OS keychain, so the key was NOT saved.";
    const anyway = `To use your ${name} key anyway, set ${variable} in the environment before starting Relavium.`;
    if (run.native.stages === undefined) {
      run.native.flow.note(`${unreachable}\n${anyway}`, 'Keychain unavailable');
      return { kind: 'finished', stored: false };
    }
    return await report(
      run,
      {
        card: { message: unreachable, title: 'Keychain unavailable' },
        done: { message: 'The key was not saved', lines: [unreachable, anyway], tone: 'failed' },
      },
      false,
    );
  }
  const remedy = nativeSetupRemedy(run.native.surface);
  if (run.native.stages === undefined) {
    run.native.flow.note(`Setup could not be completed. ${remedy}`, 'Setup failed');
    return { kind: 'finished', stored: false };
  }
  return await report(
    run,
    {
      card: { message: remedy, title: 'Setup failed' },
      done: { message: 'Setup could not be completed', lines: [remedy], tone: 'failed' },
    },
    false,
  );
}

/** The words of a stored key that every report of the starter default reuses. */
interface StoredWords {
  readonly displayName: string;
  /** The display name, scrubbed. */
  readonly name: string;
  readonly starterModel: string;
  /** The starter model, scrubbed. */
  readonly model: string;
  readonly title: 'Connected' | 'Saved';
  /** The card's first line: what happened to the key. */
  readonly storedLine: string;
  /** The Done step's line for a key kept without a check (none for a checked key). */
  readonly unchecked: readonly string[];
  readonly interrupted: string;
}

function storedWords(provider: ProviderId, verified: boolean): StoredWords {
  const displayName = providerDisplayName(provider);
  const name = scrubSetupText(displayName);
  const starterModel = KNOWN_PROVIDERS[provider].starterModel;
  return {
    displayName,
    name,
    starterModel,
    model: scrubSetupText(starterModel),
    title: verified ? 'Connected' : 'Saved',
    // Honest copy: a verified key is "Verified and stored"; a consciously-accepted key is "couldn't be verified", with the way to check it
    // that exists on both surfaces (the doctor's deep tier, as the `Save it anyway` hint says).
    storedLine: verified
      ? `Verified and stored your ${displayName} key in the OS keychain.`
      : `Your ${displayName} key is in the OS keychain, but it couldn't be verified now. Check it later with /doctor, then ${keyToken('d')}.`,
    unchecked: verified ? [] : [UNVERIFIED_KEY_LINE],
    interrupted: `${name} key stored · the default was not saved`,
  };
}

/** The Done step's sentence: the title, the provider and (when a default was chosen) the model. */
function headline(words: StoredWords, withModel: boolean): string {
  return `${words.title} · ${words.name}${withModel ? ` · ${words.model}` : ''}`;
}

/** What the default-model write came to, as one word the table below is keyed by. */
type StarterOutcome = 'saved' | 'unconfirmed' | 'ephemeral' | 'unsaved';

function starterOutcome(result: OnboardingDefaultResult | undefined): StarterOutcome {
  if (result?.kind === 'saved') return result.durability === 'confirmed' ? 'saved' : 'unconfirmed';
  return result?.kind === 'ephemeral' ? 'ephemeral' : 'unsaved';
}

/** What the card and the Done step say about the starter default, by what its write came to (`named`: the Done sentence names the model). */
const STARTER_WORDS: Record<
  StarterOutcome,
  (
    starterModel: string,
    model: string,
  ) => { readonly card: string; readonly done: readonly string[]; readonly named: boolean }
> = {
  saved: (starterModel) => ({
    card: `Your default model is ${starterModel}.`,
    done: [SETUP_NEXT_STEP],
    named: true,
  }),
  unconfirmed: (starterModel) => ({
    card: `Your default model is ${starterModel}; crash durability could not be confirmed.`,
    done: [SAVED_UNCONFIRMED, SETUP_NEXT_STEP],
    named: true,
  }),
  ephemeral: (starterModel, model) => ({
    card: `${starterModel} is selected for this invocation only; the default was not saved.`,
    done: [`${model} is selected for this invocation only; the default was not saved.`],
    named: true,
  }),
  unsaved: () => ({
    card: 'The default was not saved. Choose a model with /models.',
    done: ['The default was not saved. Choose a model with /models.'],
    named: false,
  }),
};

/**
 * Set a working default model of the CHOSEN provider (its STARTER model, the one starter table) so the very NEXT chat binds a model whose key
 * was just stored; the person changes it with `/models`. Best-effort: a config-write fault still leaves a working key (the result points at
 * `/models`) rather than undoing the store. Key maintenance (a source already worked before this setup) leaves the model preference alone.
 */
async function chooseStarter(
  run: NativeRun,
  provider: ProviderId,
  verified: boolean,
): Promise<NativeSetupResult> {
  const words = storedWords(provider, verified);
  const said = (card: string, withModel: boolean, lines: readonly string[]): Report => ({
    card: { message: `${words.storedLine}\n${card}`, title: words.title },
    done: { message: headline(words, withModel), lines: [...words.unchecked, ...lines] },
    interrupted: words.interrupted,
  });
  if (run.native.selectStarterDefault === false) {
    const kept = 'Your model preference is unchanged. Choose a model with /models.';
    return await report(run, said(kept, false, [kept]), true);
  }
  try {
    run.admit();
    const result = nativeDefaultResult(
      await run.deps.writeDefaultModel(words.starterModel, provider, run.admit),
    );
    const starter = STARTER_WORDS[starterOutcome(result)](words.starterModel, words.model);
    return await report(run, said(starter.card, starter.named, starter.done), true);
  } catch (cause) {
    return await starterFault(run, words, cause);
  }
}

/** The starter default's write threw: a cancellation keeps the stored key's fact; any other fault points at `/models`. */
async function starterFault(
  run: NativeRun,
  words: StoredWords,
  cause: unknown,
): Promise<NativeSetupResult> {
  const { deps, native } = run;
  if (native.signal.aborted && cause === native.signal.reason)
    return await report(
      run,
      {
        card: {
          message: `${words.storedLine}\nThe default model was not saved.`,
          title: words.title,
        },
        done: { message: headline(words, false), lines: ['The default model was not saved.'] },
        interrupted: words.interrupted,
      },
      true,
    );
  if (native.signal.aborted) throw cause;
  if (deps.workOwner !== undefined) {
    deps.workOwner.failure(cause);
    deps.workOwner.assertAdmitting();
  }
  const pick = `The default was not saved. Pick ${withArticle(words.displayName)} model with /models.`;
  // On a card this is the note it always was (not a committed fact: the host keeps it as what the setup left).
  if (native.stages === undefined) {
    native.flow.note(`${words.storedLine}\n${pick}`, words.title);
    return { kind: 'finished', stored: true };
  }
  return await report(
    run,
    {
      card: { message: `${words.storedLine}\n${pick}`, title: words.title },
      done: { message: headline(words, false), lines: [...words.unchecked, scrubSetupText(pick)] },
      interrupted: words.interrupted,
    },
    true,
  );
}

function nativeDefaultResult(value: unknown): OnboardingDefaultResult | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'ephemeral' || value.kind === 'cancelled') return { kind: value.kind };
  if (value.kind !== 'saved' || !('durability' in value)) return undefined;
  if (value.durability !== 'confirmed' && value.durability !== 'unconfirmed') return undefined;
  return { kind: 'saved', durability: value.durability };
}

/** Cancel observation without mistaking it for settlement of the retained producer. */
async function observeValidation(
  pending: Promise<ProviderKeyValidation>,
  signal: AbortSignal,
): Promise<ProviderKeyValidation> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Provider setup cancelled.'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
