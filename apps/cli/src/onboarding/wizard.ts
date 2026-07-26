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
  }) => Promise<string | symbol>;
  /** A MASKED key prompt (clack `password`) — the hidden interactive key input. */
  readonly password: (opts: {
    message: string;
    validate?: (value: string | undefined) => string | undefined;
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

/** The non-clack ports the wizard needs — the keychain-write path + the resolver (injected for tests). */
export interface OnboardingDeps {
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
  readonly writeDefaultModel: (modelId: string, provider: ProviderId) => void;
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
  const p = deps.prompter ?? defaultPrompter;
  p.intro('Welcome to Relavium');
  p.note(
    'Connect a model provider to start chatting.\nYour key is stored in your OS keychain — never on disk.',
    'First-run setup',
  );

  const providerValue = await p.select({
    message: 'Which provider?',
    options: KNOWN_PROVIDER_IDS.map((id) => ({
      value: id,
      label: KNOWN_PROVIDERS[id].displayName,
      hint: KNOWN_PROVIDERS[id].baseUrl,
    })),
  });
  if (p.isCancel(providerValue)) return skip(p);
  // `select` only ever yields a listed option, so narrow to the closed set WITHOUT a cast (mirrors create-prompter).
  const provider = KNOWN_PROVIDER_IDS.find((id) => id === providerValue);
  if (provider === undefined) return skip(p);

  const rawKey = await p.password({
    message: `Paste your ${KNOWN_PROVIDERS[provider].displayName} API key`,
    validate: requireKey,
  });
  if (p.isCancel(rawKey)) return skip(p);
  // Trim incidental paste whitespace (a stray space from a dashboard copy) before storing — matching
  // `readSecretFromStdin`'s `.trim()` so `provider set-key` and the wizard persist byte-identical credentials.
  // `requireKey` already rejected a whitespace-only value, so the trimmed key is non-empty.
  const key = rawKey.trim();

  // LIVE-validate the key BEFORE storing it (2.5.G S8), with a retry-not-hard-fail UX so a fat-fingered paste is
  // instantly recoverable and a bad key never lands in the keychain. `verified` is threaded into the note so the
  // "connected" copy stays honest on the continue-anyway path. `keyToStore` is what we finally persist (the
  // originally-typed or a re-entered key). A `null` return ⇒ the user skipped mid-retry.
  const outcome = await validateWithRetry(p, deps, provider, key);
  if (outcome === null) return; // skip already surfaced its note/outro
  const { keyToStore, verified } = outcome;

  // Store via the TESTED providerSetKey path (keychain.set + the provider row + the keychain-ref, secret-free). Its
  // one stdout line is suppressed (a silent io) so the wizard's output stays uniformly clack-styled — the wizard
  // surfaces the outcome through a clack note/outro instead.
  const silentIo: CliIo = { ...deps.io, writeOut: () => undefined, writeErr: () => undefined };
  try {
    await runProviderCommand(
      { action: 'set-key', name: provider },
      {
        io: silentIo,
        store: deps.store,
        keychain: deps.keychain,
        resolver: deps.resolver,
        readSecret: () => Promise.resolve(keyToStore),
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
  } catch (err) {
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
        'Setup could not be completed. Add a provider anytime with `relavium provider add`.',
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
  const storedLine = verified
    ? `Verified and stored your ${provider} key (${keyHint(keyToStore)}) in the OS keychain.`
    : `Saved your ${provider} key (${keyHint(keyToStore)}) — it couldn't be verified now. Run /doctor to re-check.`;
  try {
    deps.writeDefaultModel(starterModel, provider);
    p.note(
      `${storedLine}\nYour default model is ${starterModel} — change it anytime with /models.`,
      'Connected',
    );
  } catch {
    p.note(`${storedLine}\nPick a ${provider} model with /models to start chatting.`, 'Connected');
  }
  p.outro("You're all set — starting Relavium.");
}

/**
 * Live-validate a key with a retry loop (2.5.G S8). Returns `{ keyToStore, verified }` once the user has a key to
 * persist — verified (probe ok), or consciously accepted despite a failure ("save it anyway"). Returns `null` when
 * the user skips (a note/outro is already shown, mirroring the top-level flow). Never throws for a bad key; only a
 * clack-prompt fault propagates (caught by the Home's cleanup). Secret-free: the key is never echoed — only the
 * redacted `detail`. A bad key never reaches the keychain (storage happens only after this resolves).
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
      return validateProviderKey(adapter, k, KNOWN_PROVIDERS[id].testModel);
    });

  let keyToStore = key;
  for (;;) {
    const sp = p.spinner?.();
    sp?.start(`Checking your ${KNOWN_PROVIDERS[provider].displayName} key…`);
    // The spinner MUST stop even if the probe rejects unexpectedly (validateProviderKey never rejects, but a future
    // injected `validate` might) — otherwise a runaway spinner interval would sit over the ink-hosted Home while the
    // throw propagates to the Home's cleanup. The `finally` stops it; the throw then surfaces cleanly there.
    let res: ProviderKeyValidation;
    try {
      res = await validate(provider, keyToStore);
    } finally {
      sp?.stop('Key check finished.');
    }
    if (res.ok) return { keyToStore, verified: true };

    const isTransient = res.reason === 'network';
    const displayName = KNOWN_PROVIDERS[provider].displayName;
    const choice = await p.select(buildRetryPrompt(isTransient, displayName, res.detail));
    if (p.isCancel(choice) || choice === 'skip') {
      skip(p);
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
      skip(p);
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
function skip(p: ClackOnboardingDeps): void {
  p.note(
    'Skipped. Add a provider anytime with `relavium provider add`, or run `/doctor` to check your setup.',
    'Setup skipped',
  );
  p.outro('Starting Relavium.');
}
