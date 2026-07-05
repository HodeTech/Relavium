import { intro, isCancel, note, outro, password, select } from '@clack/prompts';
import type { ProviderStore } from '@relavium/db';

import { runProviderCommand } from '../commands/provider.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  keyHint,
  providerKeyEnvVar,
  type ProviderResolver,
} from '../engine/providers.js';
import type { CliIo } from '../process/io.js';
import type { KeychainStore } from '../secrets/keychain.js';

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
 *  - The key is read via clack's masked `password` prompt (never an argv flag, never echoed), held only in memory,
 *    and handed straight to the keychain — it is never logged (only {@link keyHint}, the last 4), persisted to a
 *    file, or placed in an error/report.
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
  }) => Promise<string | symbol>;
  /** A MASKED key prompt (clack `password`) — the hidden interactive key input. */
  readonly password: (opts: {
    message: string;
    validate?: (value: string | undefined) => string | undefined;
  }) => Promise<string | symbol>;
  /** Clack's cancel sentinel guard (Ctrl-C / ESC) — a real type guard so a non-cancel value narrows. */
  readonly isCancel: (value: unknown) => value is symbol;
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
    }),
  password: (opts) =>
    password({
      message: opts.message,
      ...(opts.validate === undefined ? {} : { validate: opts.validate }),
    }),
  isCancel,
};

/** The non-clack ports the wizard needs — the keychain-write path + the resolver (injected for tests). */
export interface OnboardingDeps {
  /** The clack slice — omit for the real prompts; a test injects a scripted one. */
  readonly prompter?: ClackOnboardingDeps;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly resolver: ProviderResolver;
  readonly io: CliIo;
}

/**
 * Whether the run is truly KEY-LESS — no known provider has a resolvable key (the resolver checks the OS keychain
 * AND the `RELAVIUM_<PROVIDER>_API_KEY` env fallback). `true` ⇒ a chat turn would fail `provider_auth`, so the
 * bare Home offers the wizard. A run with EITHER a keychain key or an env key is NOT key-less (no wizard) — so a
 * working env-key user is never nagged, and the env fallback IS the resolver's built-in key import.
 */
export function isProviderKeyless(resolver: Pick<ProviderResolver, 'keyFor'>): boolean {
  return !KNOWN_PROVIDER_IDS.some((id) => {
    try {
      resolver.keyFor(id);
      return true;
    } catch {
      return false; // no keychain key + no env var for this provider
    }
  });
}

/** A clack `validate` that rejects an empty/whitespace key (Esc still cancels the whole flow). */
const requireKey = (value: string | undefined): string | undefined =>
  (value ?? '').trim() === '' ? 'An API key is required (or press Esc to skip setup).' : undefined;

/**
 * Run the first-run wizard. Resolves when the user has stored a key OR skipped/failed — the caller (the Home) then
 * mounts as usual. Never throws for a normal cancel or a keychain-unavailable fallback (both end cleanly); only an
 * unexpected fault propagates (caught by the Home's cleanup finally).
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

  const key = await p.password({
    message: `Paste your ${KNOWN_PROVIDERS[provider].displayName} API key`,
    validate: requireKey,
  });
  if (p.isCancel(key)) return skip(p);

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
        readSecret: () => Promise.resolve(key),
      },
    );
    p.note(`Stored your ${provider} key (${keyHint(key)}) in the OS keychain.`, 'Connected');
    p.outro("You're all set — starting Relavium.");
  } catch {
    // Write-failure fallback: the OS keychain is unavailable (locked / no Secret Service / a headless box). NEVER
    // persist the key to disk — guide the user to the env var, which the resolver imports at call time
    // (keychain → env fallback). The broad catch is intentional: any failure to store degrades to the same
    // env-var guidance rather than crashing the first run.
    p.note(
      `Couldn't reach your OS keychain, so the key was NOT saved.\n` +
        `Set it in your shell instead, then restart Relavium:\n\n` +
        `  export ${providerKeyEnvVar(provider)}=<your ${provider} key>`,
      'Keychain unavailable',
    );
    p.outro('Setup incomplete — see the note above.');
  }
}

/** The cancel/skip exit: a friendly pointer to the manual path, then hand off to the Home. */
function skip(p: ClackOnboardingDeps): void {
  p.note(
    'Skipped. Add a provider anytime with `relavium provider add`, or run `/doctor` to check your setup.',
    'Setup skipped',
  );
  p.outro('Starting Relavium.');
}
