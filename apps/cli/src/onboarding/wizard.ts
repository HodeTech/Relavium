import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { intro, isCancel, note, outro, password, select, spinner } from '@clack/prompts';
import type { ProviderStore } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';

import { runProviderCommand } from '../commands/provider.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  keyHint,
  providerHasKey,
  providerKeyEnvVar,
  validateProviderKey,
  type ProviderKeyValidation,
  type ProviderResolver,
} from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { nativePromptIo } from '../process/native-prompt-io.js';
import { runSessionPrompt } from '../chat/session-prompt.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';

/**
 * The first-run onboarding wizard (workstream **2.5.G S8**) — a `@clack/prompts` flow that turns a KEY-LESS Home
 * into a working chat: pick a provider → paste a **hidden** API key → store it in the OS keychain, with a
 * keychain-write fallback that guides the user to the environment variable (the key is **NEVER** written to disk).
 * It reuses the two existing ink↔clack custody patterns: `@clack/prompts` is confined to THIS module behind an
 * injectable seam (mirroring the create wizard + the gate prompter), and the key-storage rides the **tested**
 * `providerSetKey` path (keychain.set + the provider row + the keychain-ref, secret-free by construction —
 * [provider.ts](../commands/provider.ts), ADR-0006/0019). Model selection is deliberately OUT of scope here — the
 * wizard's job is to store the key that lights up the S7 `/models` picker + chat; the user picks a model there.
 *
 * SECURITY (this captures a live API key):
 *  - The key is read via clack's masked `password` prompt (never an argv flag, never echoed) and held only in
 *    memory. Before it is stored, it is sent LIVE to the provider ONCE (the bounded, key-redacted
 *    {@link validateProviderKey} `maxTokens:1` ping) to verify it — the key crosses the network only to its own
 *    provider, over the adapter's own transport, and is never logged/persisted/echoed on that path.
 *  - It is then handed to the OS keychain. On a validation FAILURE the user may consciously "save it anyway" — the
 *    key is then stored UNVERIFIED and the note says so (never claiming a verification we didn't do).
 *  - The only key material ever surfaced is {@link keyHint} (the last 4); the redacted probe `detail` is the only
 *    failure text shown. Nothing is written to a file/log/error/report.
 *  - The keychain-unavailable fallback prints the env-var name to set — NEVER the key, and NEVER a plaintext file
 *    (the deliberate "no silent plaintext fallback" of `providerSetKey`).
 */

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

function ownedPrompter(deps: OnboardingDeps): ClackOnboardingDeps {
  if (deps.native !== undefined) {
    const flow = deps.native.flow;
    return {
      intro: () => {},
      outro: () => {},
      note: (message, title) => flow.note(message, title),
      select: (options) => flow.select(options),
      password: (options) =>
        flow.password({
          message: options.message,
          ...(options.validate === undefined ? {} : { validate: options.validate }),
        }),
      isCancel: (value: unknown): value is symbol => value === NATIVE_PROMPT_CANCEL,
    };
  }
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

export interface OnboardingDeps {
  readonly workOwner?: SessionWorkOwner;
  readonly initialProvider?: ProviderId;
  /** In-tree custody is owned by the caller, not the Clack terminal lease. */
  readonly native?: {
    readonly flow: NativePromptFlow;
    readonly signal: AbortSignal;
    readonly assertAdmitting: () => void;
    readonly endpointContext: (id: ProviderId) => string;
    /** Only a first usable-source setup chooses a starter; key maintenance preserves model preferences. */
    readonly selectStarterDefault?: boolean;
    readonly surface?: 'home' | 'standalone-chat';
  };
  /** The clack slice — omit for the real prompts; a test injects a scripted one. */
  readonly prompter?: ClackOnboardingDeps;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly resolver: ProviderResolver;
  readonly io: CliIo;
  /** Persist the NEXT session's default model AND its `provider` (ADR-0059 — authoritative at pick time) via the
   *  Home's config target. The wizard sets a starter model of the CHOSEN provider so the first chat binds a model
   *  whose key was just stored — the built-in default (`claude-sonnet-4-6` → anthropic) would otherwise error for a
   *  user who picked another provider — and persisting the provider means that first chat skips id inference. */
  readonly writeDefaultModel: (
    modelId: string,
    provider: ProviderId,
    assertAdmitting?: () => void,
  ) => unknown;
  /**
   * LIVE-validate a just-entered key (2.5.G S8) — injected for tests (no network). Absent ⇒ the real bounded,
   * key-redacted {@link validateProviderKey} probe against the provider's cheap `testModel`. The wizard uses the
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

/** A clack `validate` that rejects an empty/whitespace key (Esc still cancels the whole flow). */
const requireKey = (value: string | undefined): string | undefined =>
  (value ?? '').trim() === '' ? 'An API key is required (or press Esc to skip setup).' : undefined;

/**
 * Run the first-run wizard. Resolves when the user has stored a key OR skipped/failed — the caller (the Home) then
 * mounts as usual. Every STORAGE outcome ends cleanly (cancel → skip; keychain-unavailable → env-var guidance; any
 * other storage fault → a generic note) — none rethrow. Only a fault inside a clack prompt call itself
 * (`select`/`password`/`note`/`outro`) propagates, and that is caught by the Home's cleanup `finally`.
 */
export async function runOnboardingWizard(deps: OnboardingDeps): Promise<void> {
  try {
    await runWizard(deps);
  } catch (cause) {
    if (nativeCancelled(deps) && cause === deps.native?.signal.reason) return;
    if (deps.native !== undefined) throw new Error('Provider setup failed.');
    throw cause;
  }
}
function nativeCancelled(deps: OnboardingDeps): boolean {
  return deps.native?.signal.aborted === true;
}
function assertAdmitting(deps: OnboardingDeps): void {
  deps.workOwner?.assertAdmitting();
  deps.native?.assertAdmitting();
  deps.native?.signal.throwIfAborted();
}
async function runWizard(deps: OnboardingDeps): Promise<void> {
  assertAdmitting(deps);
  const p = ownedPrompter(deps);
  p.intro('Welcome to Relavium');
  p.note(
    'Connect a model provider to start chatting.\nYour key is stored in your OS keychain — never on disk.',
    'First-run setup',
  );

  const providerValue =
    deps.initialProvider ??
    (await p.select({
      message: 'Which provider?',
      options: KNOWN_PROVIDER_IDS.map((id) => ({
        value: id,
        label: KNOWN_PROVIDERS[id].displayName,
        hint: deps.native?.endpointContext(id) ?? KNOWN_PROVIDERS[id].baseUrl,
      })),
    }));
  if (p.isCancel(providerValue)) return skip(p, deps);
  // `select` only ever yields a listed option, so narrow to the closed set WITHOUT a cast (mirrors create-prompter).
  const provider = KNOWN_PROVIDER_IDS.find((id) => id === providerValue);
  if (provider === undefined) return skip(p, deps);

  if (deps.native !== undefined)
    p.note(deps.native.endpointContext(provider), 'Provider destination');
  const rawKey = await p.password({
    message: `Paste your ${KNOWN_PROVIDERS[provider].displayName} API key`,
    validate: requireKey,
  });
  if (p.isCancel(rawKey)) return skip(p, deps);
  // Trim incidental paste whitespace (a stray space from a dashboard copy) before storing — matching
  // `readSecretFromStdin`'s `.trim()` so `provider set-key` and the wizard persist byte-identical credentials.
  // `requireKey` already rejected a whitespace-only value, so the trimmed key is non-empty.
  const key = rawKey.trim();

  // LIVE-validate the key BEFORE storing it (2.5.G S8), with a retry-not-hard-fail UX so a fat-fingered paste is
  // instantly recoverable and a bad key never lands in the keychain. `verified` is threaded into the note so the
  // "connected" copy stays honest on the continue-anyway path. `keyToStore` is what we finally persist (the
  // originally-typed or a re-entered key). A `null` return ⇒ the user skipped mid-retry.
  const outcome = await validateWithRetry(p, deps, provider, key);
  assertAdmitting(deps);
  if (outcome === null) return; // skip already surfaced its note/outro
  const { keyToStore, verified } = outcome;

  // Store via the TESTED providerSetKey path (keychain.set + the provider row + the keychain-ref, secret-free). Its
  // one stdout line is suppressed (a silent io) so the wizard's output stays uniformly clack-styled — the wizard
  // surfaces the outcome through a clack note/outro instead.
  const silentIo: CliIo = {
    env: deps.io.env,
    stdoutIsTty: false,
    stdinIsTty: deps.io.stdinIsTty,
    stdin: deps.io.stdin,
    writeOut: () => undefined,
    writeErr: () => undefined,
    writeOutAcknowledged: () => Promise.resolve(),
    writeErrAcknowledged: () => Promise.resolve(),
  };
  let keyStored = false;
  const keychain: KeychainStore =
    deps.native === undefined
      ? deps.keychain
      : {
          get: (account) => deps.keychain.get(account),
          set: (account, value) => {
            deps.keychain.set(account, value);
            keyStored = true;
          },
          delete: (account) => deps.keychain.delete(account),
        };
  const reportCommitted = (message: string): void => {
    const flow = deps.native?.flow;
    if (flow === undefined) return;
    if (flow.committedNote !== undefined) flow.committedNote(message, 'Connected');
    else flow.note(message, 'Connected');
  };
  const store: ProviderStore =
    deps.native === undefined
      ? deps.store
      : {
          list: () => deps.store.list(),
          get: (name) => deps.store.get(name),
          upsert: (input) => {
            assertAdmitting(deps);
            return deps.store.upsert(input);
          },
          setKeychainRef: (name, ref) => {
            assertAdmitting(deps);
            deps.store.setKeychainRef(name, ref);
          },
          clearKeychainRef: (name) => {
            assertAdmitting(deps);
            deps.store.clearKeychainRef(name);
          },
        };
  try {
    await runProviderCommand(
      { action: 'set-key', name: provider },
      {
        io: silentIo,
        store,
        keychain,
        resolver: deps.resolver,
        readSecret: () => Promise.resolve(keyToStore),
        ...(deps.workOwner === undefined && deps.native === undefined
          ? {}
          : { assertAdmitting: () => assertAdmitting(deps) }),
        // `global` is read only by `provider list --json`; `set-key` never touches it — a throwaway (the wizard is
        // always interactive, never `--json`).
        global: {
          json: false,
          color: false,
          cwd: process.cwd(),
          configPath: undefined,
          verbosity: 'normal',
        },
      },
    );
    if (deps.native?.signal.aborted === true) {
      reportCommitted(
        `Your ${provider} key was stored in the OS keychain. The default model was not saved.`,
      );
      return;
    }
    assertAdmitting(deps);
  } catch (err) {
    if (deps.native?.signal.aborted === true && err === deps.native.signal.reason) {
      if (keyStored)
        reportCommitted(
          `Your ${provider} key was stored in the OS keychain, but setup was interrupted. The default model was not saved.`,
        );
      return;
    }
    if (deps.native?.signal.aborted === true) throw err;
    if (deps.workOwner !== undefined) {
      deps.workOwner.failure(err);
      deps.workOwner.assertAdmitting();
    }
    // Distinguish the EXPECTED keychain-unavailable failure (recoverable → env-var guidance) from an UNEXPECTED
    // fault (e.g. a db write). `providerSetKey` writes to the keychain FIRST, so a keychain-unavailable failure
    // persists NOTHING; mislabeling a *post*-`keychain.set` fault (a later db upsert) as "keychain unavailable, key
    // not saved" would LIE — the key IS in the keychain then. `runProviderCommand` wraps `KeychainUnavailableError`
    // in a `CliError(cause)`; the bare-`instanceof KeychainUnavailableError` disjunct is a DEFENSIVE fallback for a
    // future direct caller. Never render the raw error (it could carry context) — both branches use static text.
    const keychainDown =
      err instanceof KeychainUnavailableError ||
      (err instanceof CliError && err.cause instanceof KeychainUnavailableError);
    if (keychainDown) {
      // The no-plaintext fallback: guide the user to the env var (the resolver imports it at call time). NEVER
      // persist the key to disk.
      p.note(
        `Couldn't reach your OS keychain, so the key was NOT saved.\n` +
          `Set it in your shell instead, then restart Relavium:\n\n` +
          `  export ${providerKeyEnvVar(provider)}=<your ${provider} key>`,
        'Keychain unavailable',
      );
    } else {
      // An unexpected fault (e.g. a broken db) — do NOT claim a keychain failure. A generic pointer; the underlying
      // issue resurfaces at the Home, which reads the same store.
      p.note(
        deps.native === undefined
          ? 'Setup could not be completed. Add a provider anytime with `relavium provider add`.'
          : `Setup could not be completed. ${nativeSetupRemedy(deps.native.surface)}`,
        'Setup failed',
      );
    }
    p.outro('Setup incomplete — see the note above.');
    return;
  }

  // Set a working default model of the CHOSEN provider so the very NEXT chat binds a model whose key was just
  // stored — the built-in default (`claude-sonnet-4-6` → anthropic) would otherwise error for a user who picked a
  // different provider (breaking the "reach a working chat" promise). `testModel` is a cheap/fast, priced starter;
  // the user upgrades via `/models`. Best-effort: a config-write fault still leaves a working key (fall back to the
  // `/models` pointer) rather than undoing the store.
  const starterModel = KNOWN_PROVIDERS[provider].testModel;
  // Honest copy: a verified key is "Verified and stored"; a consciously-accepted (network/continue-anyway) key is
  // "Saved … couldn't be verified" so the user knows to re-check — never claim verification we didn't do.
  const storedLine =
    deps.native !== undefined
      ? verified
        ? `Verified and stored your ${provider} key in the OS keychain.`
        : `Saved your ${provider} key — it couldn't be verified now. Run /doctor to re-check.`
      : verified
        ? `Verified and stored your ${provider} key (${keyHint(keyToStore)}) in the OS keychain.`
        : `Saved your ${provider} key (${keyHint(keyToStore)}) — it couldn't be verified now. Run /doctor to re-check.`;
  if (deps.native?.selectStarterDefault === false) {
    reportCommitted(
      `${storedLine}\nYour model preference is unchanged. Choose a model with /models.`,
    );
    return;
  }
  try {
    assertAdmitting(deps);
    const written =
      deps.native === undefined
        ? await deps.writeDefaultModel(starterModel, provider)
        : await deps.writeDefaultModel(starterModel, provider, () => assertAdmitting(deps));
    if (deps.native !== undefined) {
      const result = nativeDefaultResult(written);
      const detail =
        result?.kind === 'saved'
          ? result.durability === 'confirmed'
            ? `Your default model is ${starterModel}.`
            : `Your default model is ${starterModel}; crash durability could not be confirmed.`
          : result?.kind === 'ephemeral'
            ? `${starterModel} is selected for this invocation only; the default was not saved.`
            : 'The default was not saved. Choose a model with /models.';
      reportCommitted(`${storedLine}\n${detail}`);
      return;
    }
    assertAdmitting(deps);
    p.note(
      `${storedLine}\nYour default model is ${starterModel} — change it anytime with /models.`,
      'Connected',
    );
  } catch (cause) {
    if (nativeCancelled(deps) && cause === deps.native?.signal.reason) {
      reportCommitted(`${storedLine}\nThe default model was not saved.`);
      return;
    }
    if (nativeCancelled(deps)) throw cause;
    if (deps.workOwner !== undefined) {
      deps.workOwner.failure(cause);
      deps.workOwner.assertAdmitting();
    }
    p.note(
      deps.native === undefined
        ? `${storedLine}\nPick a ${provider} model with /models to start chatting.`
        : `${storedLine}\nThe default was not saved. Pick a ${provider} model with /models.`,
      'Connected',
    );
    if (deps.native !== undefined) return;
  }
  p.outro("You're all set — starting Relavium.");
}

function nativeDefaultResult(value: unknown): OnboardingDefaultResult | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'ephemeral' || value.kind === 'cancelled') return { kind: value.kind };
  if (value.kind !== 'saved' || !('durability' in value)) return undefined;
  if (value.durability !== 'confirmed' && value.durability !== 'unconfirmed') return undefined;
  return { kind: 'saved', durability: value.durability };
}

/**
 * Live-validate a key with a retry loop (2.5.G S8). Returns `{ keyToStore, verified }` once the user has a key to
 * persist — verified (probe ok), or consciously accepted despite a failure ("save it anyway"). Returns `null` when
 * the user skips (a note/outro is already shown, mirroring the top-level flow). Rejected keys produce retry
 * choices; prompt, lifecycle and unexpected probe faults can propagate through Home cleanup. The key is never
 * echoed, only redacted `detail`. Storage follows this result and its explicit verification/continue decision.
 */
async function validateWithRetry(
  p: ClackOnboardingDeps,
  deps: OnboardingDeps,
  provider: ProviderId,
  key: string,
): Promise<{ keyToStore: string; verified: boolean } | null> {
  const validate =
    deps.validate ??
    (async (id: ProviderId, k: string): Promise<ProviderKeyValidation> => {
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
        KNOWN_PROVIDERS[id].testModel,
        undefined,
        owner === undefined
          ? undefined
          : { signal: owner.signal, work: owner.work, assertAdmitting: owner.assertAdmitting },
      );
    });

  let keyToStore = key;
  for (;;) {
    assertAdmitting(deps);
    if (deps.workOwner !== undefined)
      p.note(`Checking your ${KNOWN_PROVIDERS[provider].displayName} key…`, 'Verification');
    deps.native?.flow.busy(`Checking your ${KNOWN_PROVIDERS[provider].displayName} key…`);
    const sp = p.spinner?.();
    sp?.start(`Checking your ${KNOWN_PROVIDERS[provider].displayName} key…`);
    // Always stop the spinner before a probe, lifecycle or injected-validator fault propagates
    // through Home cleanup; an unresolved presentation interval does not own the real probe.
    let res: ProviderKeyValidation;
    try {
      const operation = () => validate(provider, keyToStore);
      const pending =
        deps.native !== undefined && deps.workOwner !== undefined
          ? deps.workOwner.work.retainWork(operation)
          : operation();
      res =
        deps.native === undefined
          ? await pending
          : await observeValidation(pending, deps.native.signal);
      assertAdmitting(deps);
    } finally {
      sp?.stop('Key check finished.');
    }
    if (res.ok) return { keyToStore, verified: true };

    const isTransient = res.reason === 'network';
    const displayName = KNOWN_PROVIDERS[provider].displayName;
    const choice = await p.select(
      buildRetryPrompt(
        isTransient,
        displayName,
        deps.native === undefined
          ? res.detail
          : res.reason === 'auth'
            ? 'authentication failed'
            : res.reason === 'network'
              ? 'network unavailable'
              : 'verification failed',
      ),
    );
    if (p.isCancel(choice) || choice === 'skip') {
      skip(p, deps);
      return null;
    }
    if (choice === 'continue') return { keyToStore, verified: false };
    // clack's `select` only ever yields a listed value; fail loud if a future option is added without a handler.
    if (choice !== 'retry') throw new Error(`unexpected wizard choice: ${String(choice)}`);

    // 'retry' — re-prompt for a key; Esc here also skips. The new key loops back through validation.
    const again = await p.password({
      message: `Paste your ${displayName} API key`,
      validate: requireKey,
    });
    if (p.isCancel(again)) {
      skip(p, deps);
      return null;
    }
    keyToStore = again.trim();
  }
}

/**
 * Build the failed-key retry prompt (the `p.select` payload). The order + the pre-highlighted (bare-Enter) option
 * depend on the CAUSE: a TRANSIENT (`network` — offline / timeout / rate-limit / overloaded) failure defaults to
 * "save it anyway" (don't block an offline first-run); a non-transient failure (a rejected key, a billing/account
 * issue, or an unexpected fault) defaults to "re-enter". `detail` (already key-redacted, and it names the specific
 * reason, e.g. `invalid_api_key`) is the neutral evidence — we do NOT assert "the key is bad" for the non-network
 * case, since a 402/400 may mean billing or a stale test model rather than a wrong key.
 */
function buildRetryPrompt(
  isTransient: boolean,
  displayName: string,
  detail: string,
): Parameters<ClackOnboardingDeps['select']>[0] {
  return {
    message: isTransient
      ? `Couldn't reach ${displayName} to verify — you may be offline or it's busy (${detail}).`
      : `Couldn't verify your ${displayName} key (${detail}).`,
    options: isTransient
      ? [
          { value: 'continue', label: 'Save it anyway', hint: 'verify later with /doctor' },
          { value: 'retry', label: 'Enter a different key' },
          { value: 'skip', label: 'Skip setup' },
        ]
      : [
          { value: 'retry', label: 'Enter a new key' },
          { value: 'continue', label: 'Save it anyway', hint: 'fix it later with /doctor' },
          { value: 'skip', label: 'Skip setup' },
        ],
    initialValue: isTransient ? 'continue' : 'retry',
  };
}

/** The cancel/skip exit: a friendly pointer to the manual path, then hand off to the Home. */
function nativeSetupRemedy(surface: 'home' | 'standalone-chat' | undefined): string {
  return surface === 'standalone-chat'
    ? 'Restart `relavium chat` to open provider setup, or run `/doctor` to check your setup.'
    : 'Open `/providers` to connect a key, or run `/doctor` to check your setup.';
}

function skip(p: ClackOnboardingDeps, deps: OnboardingDeps): void {
  p.note(
    deps.native === undefined
      ? 'Skipped. Add a provider anytime with `relavium provider add`, or run `/doctor` to check your setup.'
      : `Skipped. ${nativeSetupRemedy(deps.native.surface)}`,
    'Setup skipped',
  );
  p.outro('Starting Relavium.');
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
