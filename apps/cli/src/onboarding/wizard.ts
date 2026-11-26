import {
  NATIVE_PROMPT_BACK,
  type NativePromptEscape,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { exitKey, inertLegendText, keyToken, legend } from '../render/tui/legend.js';
import { authorLine } from '../render/tui/run-card-model.js';
import { foldLineSeparators } from '../popups/frame-model.js';
import { intro, isCancel, note, outro, password, select, spinner } from '@clack/prompts';
import type { ProviderStore } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';

import { runProviderCommand } from '../commands/provider.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  keyHint,
  providerDisplayName,
  providerEndpointOrigin,
  providerHasKey,
  providerKeyEnvVar,
  validateProviderKey,
  type ProviderKeyValidation,
  type ProviderResolver,
} from '../engine/providers.js';
import type { FramedDone } from '../home/framed-flow.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { nativePromptIo } from '../process/native-prompt-io.js';
import { runSessionPrompt } from '../chat/session-prompt.js';
import {
  FIRST_RUN_NOTE_TITLE,
  SETUP_NEXT_STEP,
  UNKNOWN_KEY_HOST,
  keyCheckText,
  keyStepNote,
  setupSkippedNotice,
  type SetupSurface,
} from './setup-notes.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';

/**
 * The first-run onboarding wizard (workstream **2.5.G S8**): it turns a KEY-LESS Home into a working chat: pick a provider → paste a
 * **hidden** API key → check it with the provider once → store it in the OS keychain, with a keychain-write fallback that names the environment
 * variable (the key is **NEVER** written to disk), then choose the provider's starter model as the default.
 *
 * Two paths, one set of checks:
 * - **The native setup** (`native`, every production caller): the steps run on the host's native prompt channel. On the Home they are the
 *   steps of the `/providers` popup (`native.stages`, ADR-0148 §1, ADR-0146 §6): `Provider · Key · Done`, `Esc` steps back from the key and from
 *   the choices after a failed check, and the result is a persistent Done step. In a stand-alone chat's pre-chat mount, which has no popup
 *   slot, they are the card they always were, and the result is the card's last note.
 * - **The legacy path** (an injected `prompter`, `@clack/prompts` by default): kept only as the Home's injected test seam (`HomeDeps.onboardingPrompter`);
 *   no production code reaches it.
 *
 * SECURITY (this captures a live API key):
 *  - The key is read through a masked prompt (never an argv flag, never echoed) and held only in memory: on the native path in the channel's
 *    private editor, never in a snapshot, cleared on `Esc`, on a step back and on any resize.
 *  - Before it is stored, it is sent LIVE to the provider ONCE (the bounded, key-redacted {@link validateProviderKey} `maxTokens:1` ping against
 *    the provider's STARTER model) to verify it; the native setup says so before the key is pasted and while the request runs, naming the host
 *    of the origin that receives it (G20). The key crosses the network only to its own provider, over the adapter's own transport.
 *  - It is then handed to the OS keychain. On a validation FAILURE the user may consciously "save it anyway": the key is then stored UNVERIFIED
 *    and the result says so (never claiming a verification we didn't do).
 *  - The only key material ever surfaced on the legacy path is {@link keyHint} (the last 4); the native path shows none. Nothing is written to a
 *    file, a log, an error or a report.
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

/** The narrow slice of `@clack/prompts` the wizard uses — injectable so the flow unit-tests without a TTY. */
export interface ClackOnboardingDeps {
  readonly intro: (title: string) => void;
  readonly outro: (message: string) => void;
  readonly note: (message: string, title?: string) => void;
  readonly select: (opts: {
    message: string;
    options: readonly { value: string; label: string; hint?: string }[];
    /** Pre-highlight an option so a bare Enter takes it (2.5.G S8 — the "press Enter to continue" affordance). */
    initialValue?: string;
    signal?: AbortSignal;
  }) => Promise<string | symbol>;
  /** A MASKED key prompt (clack `password`) — the hidden interactive key input. */
  readonly password: (opts: {
    message: string;
    validate?: (value: string | undefined) => string | undefined;
    signal?: AbortSignal;
  }) => Promise<string | symbol>;
  /** Clack's cancel sentinel guard (Ctrl-C / ESC) — a real type guard so a non-cancel value narrows. */
  readonly isCancel: (value: unknown) => value is symbol;
  /** An optional progress spinner for the live key-check moment (2.5.G S8) — omit ⇒ no spinner (a test no-op). */
  readonly spinner?: () => { start: (message?: string) => void; stop: (message?: string) => void };
}

// The clack-boundary adapter (the one place the library's exact option shapes are met) — spread the optional
// fields conditionally so no explicit `undefined` is passed (exactOptionalPropertyTypes), keeping the seam free
// of clack's types and free of an unsafe cast. Mirrors `create-prompter.ts`'s `defaultDeps`.
const defaultPrompter: ClackOnboardingDeps = {
  intro: (title) => intro(title),
  outro: (message) => outro(message),
  note: (message, title) => note(message, title),
  select: (opts) =>
    select({
      message: opts.message,
      options: opts.options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.hint === undefined ? {} : { hint: option.hint }),
      })),
      ...(opts.initialValue === undefined ? {} : { initialValue: opts.initialValue }),
    }),
  password: (opts) =>
    password({
      message: opts.message,
      ...(opts.validate === undefined ? {} : { validate: opts.validate }),
    }),
  isCancel,
  spinner: () => {
    const sp = spinner();
    return { start: (message) => sp.start(message), stop: (message) => sp.stop(message) };
  },
};

/** Native prompts use captured streams. Installed Clack spinner borrows ambient stdin, so omit it. */
export function createBoundOnboardingPrompter(io: CliIo): ClackOnboardingDeps {
  const streams = nativePromptIo(io);
  return {
    intro: (title) => intro(title, { output: streams.output }),
    outro: (message) => outro(message, { output: streams.output }),
    note: (message, title) => note(message, title, { output: streams.output }),
    select: (options) => select({ ...options, ...streams, options: [...options.options] }),
    password: (options) => password({ ...options, ...streams }),
    isCancel,
  };
}

/** The legacy path's prompter: the injected one (or Clack's), under the session's work owner when there is one. */
function ownedPrompter(deps: OnboardingDeps): ClackOnboardingDeps {
  const owner = deps.workOwner;
  const native =
    deps.prompter ??
    (owner === undefined ? defaultPrompter : createBoundOnboardingPrompter(deps.io));
  if (owner === undefined) return native;
  const guarded = <T>(operation: () => T): T => {
    owner.assertAdmitting();
    return operation();
  };
  return {
    intro: (title) => guarded(() => native.intro(title)),
    outro: (message) => guarded(() => native.outro(message)),
    note: (message, title) => guarded(() => native.note(message, title)),
    select: async (options) => {
      const answer = await runSessionPrompt(
        owner.invocation,
        deps.io,
        owner.assertAdmitting,
        owner.failure,
        (signal) => native.select({ ...options, signal }),
        owner.signal,
      );
      owner.assertAdmitting();
      return answer;
    },
    password: async (options) => {
      const answer = await runSessionPrompt(
        owner.invocation,
        deps.io,
        owner.assertAdmitting,
        owner.failure,
        (signal) => native.password({ ...options, signal }),
        owner.signal,
      );
      owner.assertAdmitting();
      return answer;
    },
    isCancel: native.isCancel,
  };
}

/** The non-clack ports the wizard needs — the keychain-write path + the resolver (injected for tests). */
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
  readonly done: (done: FramedDone) => Promise<void>;
}

/** What the native setup did, for the coordinator that opened it. */
export type NativeSetupResult =
  /** `Esc` stepped back from the key step and the wizard had no step before it (the caller chose the provider): the caller asks again. */
  | { readonly kind: 'back' }
  /** The person skipped the setup: `Esc` on `Which provider?`, or `Skip setup` after a failed check (and, on a card, `Esc` anywhere). */
  | { readonly kind: 'skipped' }
  /** The flow was cancelled (`Ctrl+C`, or the host stopped it) before anything was stored. */
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

export interface OnboardingDeps {
  readonly workOwner?: SessionWorkOwner;
  readonly initialProvider?: ProviderId;
  /** In-tree custody is owned by the caller, not the Clack terminal lease. */
  readonly native?: NativeOnboarding;
  /** The clack slice — omit for the real prompts; a test injects a scripted one. */
  readonly prompter?: ClackOnboardingDeps;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly resolver: ProviderResolver;
  readonly io: CliIo;
  /** Persist the NEXT session's default model AND its `provider` (ADR-0059 — authoritative at pick time) via the
   *  Home's config target. The wizard sets the CHOSEN provider's starter model (`KNOWN_PROVIDERS[id].starterModel`) so the first chat binds a
   *  model whose key was just stored, and persisting the provider means that first chat skips id inference. */
  readonly writeDefaultModel: (
    modelId: string,
    provider: ProviderId,
    assertAdmitting?: () => void,
  ) => unknown;
  /**
   * LIVE-validate a just-entered key (2.5.G S8) — injected for tests (no network). Absent ⇒ the real bounded,
   * key-redacted {@link validateProviderKey} probe against the provider's `starterModel`. The wizard uses the
   * result's `reason` to branch the retry UX (auth → re-enter; network → continue-anyway). A resolver with no
   * adapter (a test stub) validates as `ok` so the flow never blocks on an un-probeable provider.
   */
  readonly validate?: (id: ProviderId, key: string) => Promise<ProviderKeyValidation>;
}

/**
 * Whether the run is truly KEY-LESS — no known provider has a resolvable key (the resolver checks the OS keychain
 * AND the `RELAVIUM_<PROVIDER>_API_KEY` env fallback). `true` ⇒ a chat turn would fail `provider_auth`, so the
 * bare Home offers the wizard. A run with EITHER a keychain key or an env key is NOT key-less (no wizard) — so a
 * working env-key user is never nagged, and the env fallback IS the resolver's built-in key import.
 */
export function isProviderKeyless(resolver: Pick<ProviderResolver, 'keyFor' | 'hasKey'>): boolean {
  return !KNOWN_PROVIDER_IDS.some((id) => providerHasKey(resolver, id));
}

/**
 * A clack `validate` that rejects an empty/whitespace key (Esc still cancels the whole flow). The native card shows its own fixed sentence for a
 * rejected secret, so this one is the plain terminal's only word on what `Esc` does there: it skips setup.
 */
export const requireKey = (value: string | undefined): string | undefined =>
  (value ?? '').trim() === ''
    ? legend([{ text: 'An API key is required' }], exitKey.close('Esc', 'skip setup'))
    : undefined;

/**
 * Run the first-run wizard. Resolves when the user has stored a key OR skipped/failed — the caller (the Home) then
 * mounts as usual. Every STORAGE outcome ends cleanly (cancel → skip; keychain-unavailable → env-var guidance; any
 * other storage fault → a generic note) — none rethrow. Only a fault inside a prompt call itself propagates (on the native path as the fixed
 * `Provider setup failed.`), and that is caught by the Home's cleanup `finally`.
 */
export async function runOnboardingWizard(deps: OnboardingDeps): Promise<void> {
  if (deps.native !== undefined) {
    await runNativeSetup(deps, deps.native);
    return;
  }
  await runWizard(deps);
}

/**
 * The native setup (see the module header), with what it did. A cancellation that is the flow's own (its signal's reason) is `cancelled`; any
 * other fault becomes the fixed `Provider setup failed.` (nothing of its cause reaches a host's words).
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

function assertAdmitting(deps: OnboardingDeps): void {
  deps.workOwner?.assertAdmitting();
  deps.native?.assertAdmitting();
  deps.native?.signal.throwIfAborted();
}

/** The legacy path (an injected prompter): unchanged since 2.5.G S8, kept only as the Home's injected test seam. */
async function runWizard(deps: OnboardingDeps): Promise<void> {
  assertAdmitting(deps);
  const p = ownedPrompter(deps);
  p.intro('Welcome to Relavium');
  p.note(
    'Connect a model provider to start chatting.\nYour key is stored in your OS keychain — never on disk.',
    FIRST_RUN_NOTE_TITLE,
  );

  const providerValue =
    deps.initialProvider ??
    (await p.select({
      message: 'Which provider?',
      options: KNOWN_PROVIDER_IDS.map((id) => ({
        value: id,
        label: KNOWN_PROVIDERS[id].displayName,
        hint: KNOWN_PROVIDERS[id].baseUrl,
      })),
    }));
  if (p.isCancel(providerValue)) return skipLegacy(p);
  // `select` only ever yields a listed option, so narrow to the closed set WITHOUT a cast (mirrors create-prompter).
  const provider = KNOWN_PROVIDER_IDS.find((id) => id === providerValue);
  if (provider === undefined) return skipLegacy(p);
  const displayName = providerDisplayName(provider);

  const rawKey = await p.password({
    message: `Paste your ${KNOWN_PROVIDERS[provider].displayName} API key`,
    validate: requireKey,
  });
  if (p.isCancel(rawKey)) return skipLegacy(p);
  // Trim incidental paste whitespace (a stray space from a dashboard copy) before storing — matching
  // `readSecretFromStdin`'s `.trim()` so `provider set-key` and the wizard persist byte-identical credentials.
  // `requireKey` already rejected a whitespace-only value, so the trimmed key is non-empty.
  const key = rawKey.trim();

  const outcome = await validateWithRetry(p, deps, provider, key);
  assertAdmitting(deps);
  if (outcome === null) return; // skip already surfaced its note/outro
  const { keyToStore, verified } = outcome;

  try {
    await runProviderCommand(
      { action: 'set-key', name: provider },
      {
        io: silentIo(deps.io),
        store: deps.store,
        keychain: deps.keychain,
        resolver: deps.resolver,
        readSecret: () => Promise.resolve(keyToStore),
        ...(deps.workOwner === undefined ? {} : { assertAdmitting: () => assertAdmitting(deps) }),
        global: THROWAWAY_GLOBAL,
      },
    );
  } catch (err) {
    if (deps.workOwner !== undefined) {
      deps.workOwner.failure(err);
      deps.workOwner.assertAdmitting();
    }
    if (isKeychainDown(err)) {
      p.note(
        `Couldn't reach your OS keychain, so the key was NOT saved.\n` +
          `To use your ${displayName} key anyway, set ${providerKeyEnvVar(provider)} in the environment before starting Relavium.`,
        'Keychain unavailable',
      );
    } else {
      p.note(
        'Setup could not be completed. Add a provider anytime with /providers.',
        'Setup failed',
      );
    }
    p.outro('Setup incomplete — see the note above.');
    return;
  }

  const starterModel = KNOWN_PROVIDERS[provider].starterModel;
  const committedTitle = verified ? 'Connected' : 'Saved';
  const storedLine = verified
    ? `Verified and stored your ${displayName} key (${keyHint(keyToStore)}) in the OS keychain.`
    : `Your ${displayName} key (${keyHint(keyToStore)}) is in the OS keychain, but it couldn't be verified now. Open a chat to check it.`;
  try {
    assertAdmitting(deps);
    await deps.writeDefaultModel(starterModel, provider);
    assertAdmitting(deps);
    p.note(
      `${storedLine}\nYour default model is ${starterModel} — change it anytime with /models.`,
      committedTitle,
    );
  } catch (cause) {
    if (deps.workOwner !== undefined) {
      deps.workOwner.failure(cause);
      deps.workOwner.assertAdmitting();
    }
    p.note(
      `${storedLine}\nPick ${withArticle(displayName)} model with /models to start chatting.`,
      committedTitle,
    );
  }
  p.outro("You're all set — starting Relavium.");
}

/** The legacy path's skip. */
function skipLegacy(p: ClackOnboardingDeps): void {
  p.note(
    'Skipped. Add a provider anytime with /providers, or run /doctor to check your setup.',
    'Setup skipped',
  );
  p.outro('Starting Relavium.');
}

/** `global` is read only by `provider list --json`; `set-key` never touches it — a throwaway (the wizard is always interactive). */
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
): (id: ProviderId, key: string) => Promise<ProviderKeyValidation> {
  return async (id, k) => {
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
      owner === undefined
        ? undefined
        : { signal: owner.signal, work: owner.work, assertAdmitting: owner.assertAdmitting },
    );
  };
}

/**
 * Live-validate a key with a retry loop (2.5.G S8), the legacy path. Returns `{ keyToStore, verified }` once the user has a key to persist,
 * or `null` when the user skips (a note/outro is already shown).
 */
async function validateWithRetry(
  p: ClackOnboardingDeps,
  deps: OnboardingDeps,
  provider: ProviderId,
  key: string,
): Promise<{ keyToStore: string; verified: boolean } | null> {
  const validate = deps.validate ?? defaultValidate(deps);
  let keyToStore = key;
  for (;;) {
    assertAdmitting(deps);
    if (deps.workOwner !== undefined)
      p.note(`Checking your ${KNOWN_PROVIDERS[provider].displayName} key…`, 'Verification');
    const sp = p.spinner?.();
    sp?.start(`Checking your ${KNOWN_PROVIDERS[provider].displayName} key…`);
    // Always stop the spinner before a probe, lifecycle or injected-validator fault propagates.
    let res: ProviderKeyValidation;
    try {
      res = await validate(provider, keyToStore);
      assertAdmitting(deps);
    } finally {
      sp?.stop('Key check finished.');
    }
    if (res.ok) return { keyToStore, verified: true };

    const isTransient = res.reason === 'network';
    const displayName = KNOWN_PROVIDERS[provider].displayName;
    const choice = await p.select(buildRetryPrompt(isTransient, displayName, res.detail));
    if (p.isCancel(choice) || choice === 'skip') {
      skipLegacy(p);
      return null;
    }
    if (choice === 'continue') return { keyToStore, verified: false };
    if (choice === 'recheck') continue;
    // clack's `select` only ever yields a listed value; fail loud if a future option is added without a handler.
    if (choice !== 'retry') throw new Error(`unexpected wizard choice: ${String(choice)}`);

    const again = await p.password({
      message: `Paste your ${displayName} API key`,
      validate: requireKey,
    });
    if (p.isCancel(again)) {
      skipLegacy(p);
      return null;
    }
    keyToStore = again.trim();
  }
}

/** The hint of `Save it anyway · not verified`: how to verify the key later, on the surface where the doctor's deep tier is `[d]`. */
export const SAVE_ANYWAY_HINT = `not checked · verify later with /doctor, then ${keyToken('d')}`;
/** What the Done step of a key saved without a check says about it: not verified, and how to verify it (the doctor's deep tier). */
export const UNVERIFIED_KEY_LINE = `Not verified · check it later with /doctor, then ${keyToken('d')}`;

/**
 * Build the failed-key retry prompt (the select's payload). The options and the pre-highlighted (bare-Enter) one depend on the CAUSE, and
 * a failed check is never answered by a reflex `Enter` into an unverified key (ADR-0146 §6):
 *
 * - a TRANSIENT (`network`: offline, a timeout, rate limit, overloaded) failure puts `Retry the check` first and pre-selected: the same key
 *   is checked again, with nothing to paste, so a poor connection does not push toward saving it unverified;
 * - any other failure (a rejected key, a billing or account issue, an unexpected fault) puts `Enter a different key` first and
 *   pre-selected. `detail` (key-redacted, or the native setup's fixed word) is the neutral evidence: we do NOT assert "the key is bad" for the
 *   non-network case, since a 402/400 may mean billing or a stale model rather than a wrong key.
 *
 * `Save it anyway · not verified` is never pre-selected and sits last but one, and `Skip setup` is last. Its hint names how to verify later:
 * the doctor's deep tier (`/doctor`, then `[d]`), which checks the stored key with the same request.
 */
function buildRetryPrompt(
  isTransient: boolean,
  displayName: string,
  detail: string,
): Parameters<ClackOnboardingDeps['select']>[0] {
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
      ? [{ value: 'recheck', label: 'Retry the check' }, enterDifferent, saveAnyway, skipSetup]
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

// ─── The native setup ────────────────────────────────────────────────────────────────────────────────────────────────

/** The fixed words the native setup shows for a failed check (never the provider's own text, which can echo the request). */
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

/** What one turn of the key step came to. */
type KeyOutcome =
  | { readonly kind: 'key'; readonly key: string; readonly verified: boolean }
  | { readonly kind: 'again' }
  | Extract<NativeSetupResult, { readonly kind: 'back' | 'skipped' | 'cancelled' }>;

/** The parts of a native run every step reads. */
interface NativeRun {
  readonly deps: OnboardingDeps;
  readonly native: NativeOnboarding;
  /** `back` in the popup (`Esc` steps back from the key and from the choices after a failed check); `cancel` on a card (as it always was). */
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
    admit: () => assertAdmitting(deps),
  };
  run.admit();
  const firstRun = native.selectStarterDefault !== false;
  for (;;) {
    // The first-run sentence belongs to a genuine first run (`selectStarterDefault` is exactly "no usable source before this setup"); a step
    // back from the key step takes the key step's note away with it.
    if (firstRun) native.flow.note(FIRST_RUN_SENTENCE, FIRST_RUN_NOTE_TITLE);
    else if (native.stages !== undefined) native.flow.note('');
    const provider = deps.initialProvider ?? (await chooseProvider(run));
    if (provider === undefined) return { kind: 'skipped' };
    const keyed = await keyStep(run, provider);
    if (keyed.kind === 'back' && deps.initialProvider === undefined) continue;
    if (keyed.kind !== 'key') return keyed.kind === 'again' ? { kind: 'back' } : keyed;
    return await storeKey(run, provider, keyed.key, keyed.verified);
  }
}

/** On a card, a way out of the setup says it was a skip, in its one line (the popup's host says it instead, as a notification). */
function cardSkip(run: NativeRun): Extract<NativeSetupResult, { readonly kind: 'skipped' }> {
  if (run.native.stages === undefined) run.native.flow.note(setupSkippedNotice(run.native.surface));
  return { kind: 'skipped' };
}

/** The `Provider` step: `Which provider?`. `Esc` there is the way out of the setup (`skip for now` on the popup's first step). */
async function chooseProvider(run: NativeRun): Promise<ProviderId | undefined> {
  const prompts = run.native.stages?.provider ?? run.native.flow;
  const picked = await prompts.select({
    message: 'Which provider?',
    options: KNOWN_PROVIDER_IDS.map((id) => ({
      value: id,
      label: KNOWN_PROVIDERS[id].displayName,
      hint: scrubSetupText(run.native.endpointContext(id)),
    })),
  });
  const provider =
    typeof picked === 'string' ? KNOWN_PROVIDER_IDS.find((id) => id === picked) : undefined;
  if (provider === undefined) cardSkip(run);
  return provider;
}

/** The way out of a prompt of the key step: a skip on a card (`Esc` there always skipped), a cancel in the popup (`Ctrl+C`). */
function leaveKeyStep(run: NativeRun): KeyOutcome {
  return run.native.stages === undefined ? cardSkip(run) : { kind: 'cancelled' };
}

/**
 * The `Key` step: what happens to the key (stored in the OS keychain, sent once to one host to check it), the masked prompt, the check, and the
 * choices after a failed check. `Esc` on the prompt steps back to the `Provider` step; on the choices it returns to the prompt.
 */
async function keyStep(run: NativeRun, provider: ProviderId): Promise<KeyOutcome> {
  const prompts = run.native.stages?.key ?? run.native.flow;
  const name = scrubSetupText(KNOWN_PROVIDERS[provider].displayName);
  const host = keyDestinationHost(run.deps.resolver, provider);
  for (;;) {
    run.admit();
    run.native.flow.note(keyStepNote(host));
    const raw = await prompts.password({
      message: `Paste your ${name} API key`,
      validate: requireKey,
      escape: run.escape,
    });
    if (raw === NATIVE_PROMPT_BACK) return { kind: 'back' };
    if (typeof raw === 'symbol') return leaveKeyStep(run);
    // Trim incidental paste whitespace before storing, as `provider set-key` does; `requireKey` rejected a whitespace-only value.
    const checked = await checkKey(run, prompts, provider, raw.trim(), { name, host });
    if (checked.kind !== 'again') return checked;
  }
}

/** The check of one key and the choices after it failed, until a key is kept, the person asks for the key step again, or leaves. */
async function checkKey(
  run: NativeRun,
  prompts: SetupPrompts,
  provider: ProviderId,
  key: string,
  words: { readonly name: string; readonly host: string },
): Promise<KeyOutcome> {
  const validate = run.deps.validate ?? defaultValidate(run.deps);
  const owner = run.deps.workOwner;
  for (;;) {
    run.admit();
    prompts.busy(keyCheckText(words.name, words.host));
    const operation = () => validate(provider, key);
    const result = await observeValidation(
      owner === undefined ? operation() : owner.work.retainWork(operation),
      run.native.signal,
    );
    run.admit();
    if (result.ok) return { kind: 'key', key, verified: true };
    const choice = await prompts.select({
      ...buildRetryPrompt(result.reason === 'network', words.name, failureWord(result.reason)),
      escape: run.escape,
    });
    if (choice === NATIVE_PROMPT_BACK || choice === 'retry') return { kind: 'again' };
    if (typeof choice === 'symbol') return leaveKeyStep(run);
    if (choice === 'skip') return cardSkip(run);
    if (choice === 'continue') return { kind: 'key', key, verified: false };
    // 'recheck' (offered after a network failure only): the same check again with the SAME key, which this loop still holds.
    if (choice !== 'recheck') throw new Error(`unexpected wizard choice: ${choice}`);
  }
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
  const { deps, native } = run;
  const displayName = providerDisplayName(provider);
  const name = scrubSetupText(displayName);
  const starterModel = KNOWN_PROVIDERS[provider].starterModel;
  const model = scrubSetupText(starterModel);
  const title = verified ? 'Connected' : 'Saved';
  // Honest copy: a verified key is "Verified and stored"; a consciously-accepted key is "couldn't be verified" so the person knows to re-check.
  const storedLine = verified
    ? `Verified and stored your ${displayName} key in the OS keychain.`
    : `Your ${displayName} key is in the OS keychain, but it couldn't be verified now. Open a chat to check it.`;
  const unchecked: readonly string[] = verified ? [] : [UNVERIFIED_KEY_LINE];
  const headline = (withModel: boolean): string =>
    `${title} · ${name}${withModel ? ` · ${model}` : ''}`;
  const interrupted = `${name} key stored · the default was not saved`;
  if (native.selectStarterDefault === false) {
    return await report(
      run,
      {
        card: {
          message: `${storedLine}\nYour model preference is unchanged. Choose a model with /models.`,
          title,
        },
        done: {
          message: headline(false),
          lines: [...unchecked, 'Your model preference is unchanged. Choose a model with /models.'],
        },
        interrupted,
      },
      true,
    );
  }
  try {
    run.admit();
    const result = nativeDefaultResult(
      await deps.writeDefaultModel(starterModel, provider, run.admit),
    );
    const cardDetail =
      result?.kind === 'saved'
        ? result.durability === 'confirmed'
          ? `Your default model is ${starterModel}.`
          : `Your default model is ${starterModel}; crash durability could not be confirmed.`
        : result?.kind === 'ephemeral'
          ? `${starterModel} is selected for this invocation only; the default was not saved.`
          : 'The default was not saved. Choose a model with /models.';
    const doneLines: readonly string[] =
      result?.kind === 'saved'
        ? result.durability === 'confirmed'
          ? [SETUP_NEXT_STEP]
          : ['Saved, but persistence after a crash is unconfirmed.', SETUP_NEXT_STEP]
        : result?.kind === 'ephemeral'
          ? [`${model} is selected for this invocation only; the default was not saved.`]
          : ['The default was not saved. Choose a model with /models.'];
    return await report(
      run,
      {
        card: { message: `${storedLine}\n${cardDetail}`, title },
        done: {
          message: headline(result?.kind === 'saved' || result?.kind === 'ephemeral'),
          lines: [...unchecked, ...doneLines],
        },
        interrupted,
      },
      true,
    );
  } catch (cause) {
    if (native.signal.aborted && cause === native.signal.reason)
      return await report(
        run,
        {
          card: { message: `${storedLine}\nThe default model was not saved.`, title },
          done: { message: headline(false), lines: ['The default model was not saved.'] },
          interrupted,
        },
        true,
      );
    if (native.signal.aborted) throw cause;
    if (deps.workOwner !== undefined) {
      deps.workOwner.failure(cause);
      deps.workOwner.assertAdmitting();
    }
    const pick = `The default was not saved. Pick ${withArticle(displayName)} model with /models.`;
    // On a card this is the note it always was (not a committed fact: the host keeps it as what the setup left).
    if (native.stages === undefined) {
      native.flow.note(`${storedLine}\n${pick}`, title);
      return { kind: 'finished', stored: true };
    }
    return await report(
      run,
      {
        card: { message: `${storedLine}\n${pick}`, title },
        done: { message: headline(false), lines: [...unchecked, scrubSetupText(pick)] },
        interrupted,
      },
      true,
    );
  }
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
