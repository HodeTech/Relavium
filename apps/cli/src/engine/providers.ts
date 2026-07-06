import type { WorkflowDefinition } from '@relavium/core';
import type { ProviderStore } from '@relavium/db';
import {
  createCustomOpenAiProvider,
  defaultProviders,
  InvalidBaseUrlError,
  type LlmProvider,
  type ProviderId,
} from '@relavium/llm';
import type { Agent } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';
import { createValidatedFetch, type FetchLike } from './validated-fetch.js';

/**
 * The CLI's provider seam (ADR-0038 host-injected resolution). `resolveProvider` returns the keyless
 * `@relavium/llm` adapter for an authored provider id; `keyFor` resolves that provider's API key through the
 * documented chain: **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error** (2.C; the `secrets.enc`
 * encrypted-file fallback is deferred past v1.0 per keychain-and-secrets.md). A key is read only when
 * `keyFor` is invoked (per attempt) and is never logged, stored, or returned to a renderer.
 *
 * Injectable so a test (and the 2.K regression harness) drives a stub provider + dummy key; the keychain is
 * an **optional** source so tests / the harness stay keychain-free (env-only) while production injects the
 * real `@napi-rs/keyring` store.
 */
export interface ProviderResolver {
  readonly resolveProvider: (id: ProviderId) => LlmProvider | undefined;
  readonly keyFor: (id: ProviderId) => string;
  /**
   * Whether a key for `id` is RESOLVABLE (keychain OR env) — a boolean, never the key value (2.5.G key-awareness).
   * Used by the `/models` picker to gate a keyless provider's models and by `isProviderKeyless`. Only the genuine
   * "no source" case returns `false`; a real keychain fault still PROPAGATES (it is not silently reported as "no
   * key"), so a locked keychain is not misread as absence. OPTIONAL so a test stub can implement `keyFor` alone —
   * consumers go through {@link providerHasKey}, which falls back to a `keyFor` probe when this is absent. The real
   * {@link createProviderResolver} always provides it (the fault-preserving path), so production never falls back.
   */
  readonly hasKey?: (id: ProviderId) => boolean;
}

/**
 * Whether `resolver` can resolve a key for `id` — a boolean, never the key. Prefers the resolver's own
 * {@link ProviderResolver.hasKey} (the fault-preserving path production always provides); falls back to a
 * `keyFor` try/probe only when a (test) stub omits it. Centralizes the "does this provider have a key" question
 * so the picker key-gate + `isProviderKeyless` share one source (2.5.G key-awareness).
 */
export function providerHasKey(
  resolver: Pick<ProviderResolver, 'keyFor' | 'hasKey'>,
  id: ProviderId,
): boolean {
  if (resolver.hasKey !== undefined) return resolver.hasKey(id);
  try {
    resolver.keyFor(id);
    return true;
  } catch {
    return false; // a stub with no key source for this provider
  }
}

/** The env var holding a provider's API key — the headless per-invocation key source (CI / no-keychain). */
export function providerKeyEnvVar(id: ProviderId): string {
  return `RELAVIUM_${id.toUpperCase()}_API_KEY`;
}

/** A non-secret display hint for a key — masked, with the last 4 chars (or fully masked when too short). NEVER the full key. */
export function keyHint(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

/** A known provider's metadata — display name, base URL, a cheap model for the live key test, and the public
 *  pricing page (the ADR-0065 §1 default `pricing_reference_url`, where a user finds a price to hand-enter). */
export interface ProviderMeta {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly testModel: string;
  /** The provider's public pricing page — the default `llm_providers.pricing_reference_url` seeded on
   *  `provider add` (overridable with `--pricing-url`). A display-only pointer; NEVER fetched (not an egress
   *  target), so it needs no SSRF gate. Verified 2026-07-06 against each provider's live docs. */
  readonly pricingUrl: string;
}

/**
 * The known providers (each has an `@relavium/llm` adapter). The single home for provider metadata — the
 * `relavium provider` command (add / test) and the `/doctor --deep` key probe both read it, so a new provider's
 * test model is defined once.
 */
/** The provider ids the CLI knows how to validate (those with a test model). The const tuple is the SOURCE OF
 *  TRUTH — `satisfies` validates each is a real `ProviderId` (no cast, no widening), and {@link KNOWN_PROVIDERS}
 *  is keyed on it, so the two cannot drift; the `/doctor` provider probe iterates it directly. */
export const KNOWN_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
] as const satisfies readonly ProviderId[];

export const KNOWN_PROVIDERS: Record<(typeof KNOWN_PROVIDER_IDS)[number], ProviderMeta> = {
  anthropic: {
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    testModel: 'claude-haiku-4-5',
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    testModel: 'gpt-5.4-mini',
    pricingUrl: 'https://platform.openai.com/docs/pricing',
  },
  gemini: {
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    testModel: 'gemini-2.5-flash',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    testModel: 'deepseek-v4-flash',
    pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
};

/** The default per-request bound for a live key validation — long enough for a cold provider handshake, short
 *  enough that a stalled provider can never hang `provider test` or `/doctor --deep`. */
export const VALIDATE_KEY_TIMEOUT_MS = 10_000;

/** The outcome of a {@link validateProviderKey} probe — `ok` plus a secret-free `detail` line. */
export interface ProviderKeyValidation {
  readonly ok: boolean;
  /** Secret-free: `key works (<model>)` on success, or `key test failed — <redacted>` on failure. */
  readonly detail: string;
}

/**
 * Validate a provider key with a minimal live request (`maxTokens: 1` 'ping'). Returns a RESULT so the caller
 * decides whether to throw (`provider test`) or collect it (the `/doctor --deep` probe) — the redaction lives
 * here, in one tested place.
 *
 * SECURITY — the key is in scope here: `@relavium/llm` already scrubs secrets from its error messages, but we
 * defensively redact any occurrence (`raw.split(key).join(keyHint(key))`) before surfacing AND never attach
 * `err` as a cause (it could carry the key in a nested field a `--verbose` render might expose).
 *
 * The request is BOUNDED here — by an `AbortController` (cancels the in-flight request) AND a hard `Promise.race`
 * timeout (settles the call even if an adapter ignores the signal) — so BOTH callers (`provider test` and the
 * `/doctor --deep` probe) are bounded by construction; a stalled provider can never hang the CLI.
 */
export async function validateProviderKey(
  provider: LlmProvider,
  key: string,
  model: string,
  timeoutMs: number = VALIDATE_KEY_TIMEOUT_MS,
): Promise<ProviderKeyValidation> {
  // Defensive: an empty key would make the redaction `raw.split('').join(keyHint(''))` split on every character
  // and garble the message (no secret leaks — the key is empty — but the detail becomes nonsense). All current
  // callers resolve a non-empty key (createProviderResolver rejects `''`); this closes the footgun at the seam.
  if (key.length === 0) {
    return { ok: false, detail: 'key test failed — (no key)' };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderKeyValidation>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, detail: `key test failed — timeout (${timeoutMs}ms)` });
    }, timeoutMs);
  });
  const probe = (async (): Promise<ProviderKeyValidation> => {
    try {
      await provider.generate(
        {
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxTokens: 1,
          signal: controller.signal,
        },
        key,
      );
      return { ok: true, detail: `key works (${model})` };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `key test failed — ${raw.split(key).join(keyHint(key))}` };
    }
  })();
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The provider ids whose key is **guaranteed** needed by a parsed workflow — the **primary**
 * `provider` (the authored `agent.provider`, never derived from the model) of every inline agent
 * referenced by an `agent` node. Powers the `relavium run` key pre-flight so a missing key is a clean
 * exit-2 invocation error rather than a mid-run failure, and is deliberately a **strict subset** of
 * the keys a run might touch so it can never false-fail a valid run:
 *
 * - A missing **primary** key is fatal at the first attempt — `auth` is not in `RETRYABLE_KINDS`
 *   (@relavium/llm), so the FallbackChain never fails over from it; the node fails regardless of any
 *   fallback. The primary key is therefore always required, so demanding it up-front is always correct.
 * - A **`fallback_chain`** provider's key is read lazily, only if the chain actually fails over to it
 *   (a retryable primary failure). A run whose primary succeeds never needs it — so it is **excluded**
 *   here (demanding it would false-fail that run); a genuinely-missing fallback key surfaces at runtime.
 * - A **`$ref`** / registry agent is **skipped**: the CLI cannot resolve external `.agent.yaml` agents
 *   until 2.M–2.Q, so its key (like a fallback's) surfaces at runtime instead.
 */
export function neededProviderIds(def: WorkflowDefinition): ProviderId[] {
  const referencedRefs = new Set<string>();
  for (const node of def.workflow.nodes) {
    if (node.type === 'agent') {
      referencedRefs.add(node.agent_ref);
    }
  }
  const inlineAgents = (def.workflow.agents ?? []).filter((agent): agent is Agent => 'id' in agent);
  const needed = new Set<ProviderId>();
  for (const ref of referencedRefs) {
    const agent = inlineAgents.find((candidate) => candidate.id === ref);
    if (agent === undefined) {
      continue; // a `$ref` / registry agent — not resolvable in the CLI yet; let it fall through to runtime
    }
    needed.add(agent.provider); // primary only — a fallback key is conditional (see the doc above)
  }
  return [...needed];
}

/** Options threading the provider registry (for custom endpoints) into the resolver — all optional so the pre-S9
 *  callers (and tests) that pass none keep the static default-endpoint behavior. */
export interface ProviderResolverOptions {
  /** The provider registry — a row carrying a CUSTOM `base_url` (≠ the known default) rebinds its provider's
   *  adapter to a validated per-provider endpoint (2.5.G S9, ADR-0065 §3–4). Absent ⇒ default endpoints only. */
  readonly providerStore?: Pick<ProviderStore, 'list'>;
  /** The SSRF-validated `fetch` custom endpoints egress through — injectable so a test drives a fake `EgressDeps`.
   *  Default: {@link createValidatedFetch} over Node's real DNS + pinned-HTTPS connect. */
  readonly validatedFetch?: FetchLike;
}

export function createProviderResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
  keychain?: KeychainStore,
  options: ProviderResolverOptions = {},
): ProviderResolver {
  // Keyless adapters built once and reused; the key is injected per call via `keyFor`. The default provider→adapter
  // mapping lives in the seam package (`@relavium/llm`); a stored CUSTOM `base_url` (ADR-0065 §3) rebinds its
  // provider's adapter to a validated per-provider endpoint here.
  const adapters: Record<ProviderId, LlmProvider> = { ...defaultProviders() };
  applyCustomEndpoints(adapters, options);
  // The ONE key-resolution path (keychain → env), returning `undefined` for genuine absence — shared by `keyFor`
  // (which throws on absence) and `hasKey` (which returns a boolean), so the two never drift (2.5.G key-awareness).
  const resolveKey = (id: ProviderId): string | undefined => {
    // 1. OS keychain (the primary store, 2.C). Absent (`null`) → fall through to env; an *unavailable* backend
    //    (locked / no Secret Service) also falls through — the env var is the CLI's documented no-keychain path.
    //    A NON-KeychainUnavailableError (a native binding fault) PROPAGATES — it is not silent absence.
    if (keychain !== undefined) {
      let fromKeychain: string | null = null;
      try {
        fromKeychain = keychain.get(keychainAccount(id));
      } catch (err) {
        if (!(err instanceof KeychainUnavailableError)) {
          throw err;
        }
      }
      if (fromKeychain !== null && fromKeychain !== '') {
        return fromKeychain;
      }
    }
    // 2. Env var — the headless / CI per-invocation source.
    const fromEnv = env[providerKeyEnvVar(id)];
    if (fromEnv !== undefined && fromEnv !== '') {
      return fromEnv;
    }
    return undefined; // 3. No source.
  };
  return {
    resolveProvider: (id) => adapters[id],
    keyFor: (id) => {
      const key = resolveKey(id);
      if (key === undefined) {
        // A clean invocation error naming both ways to provide the key (never the key itself).
        throw new CliError(
          'invalid_invocation',
          `no API key for provider '${id}' — store one with \`relavium provider set-key ${id}\` or set ${providerKeyEnvVar(id)}.`,
        );
      }
      return key;
    },
    // Boolean-only (never the key). A real keychain fault still propagates via `resolveKey` — only genuine absence
    // is `false`, so a locked keychain is not misreported as "no key" here.
    hasKey: (id) => resolveKey(id) !== undefined,
  };
}

/**
 * Rebind a provider's adapter to a validated CUSTOM-endpoint adapter when its stored row carries a `base_url` that
 * differs from the known default (2.5.G S9, ADR-0065 §3–4). Only **OpenAI-compatible** (`openai`/`deepseek`) is
 * supported this round; `provider add` refuses a custom `base_url` on `anthropic`/`gemini`, so a stored one on them
 * shouldn't exist — skipped defensively. The custom endpoint's egress rides the host's **SSRF-validated fetch**
 * (`connectValidated`), and the adapter's construction-time `assertHttpsBaseUrl` (HTTPS + private-range + no-creds)
 * gate re-validates the URL. A `base_url` that fails that gate is **skipped** (the default endpoint stands) rather
 * than crashing resolver creation for EVERY command — the fail-fast refusal is at `provider add`; this is the
 * defensive net for a pre-S9 / tampered row.
 */
function applyCustomEndpoints(
  adapters: Record<ProviderId, LlmProvider>,
  options: ProviderResolverOptions,
): void {
  const store = options.providerStore;
  if (store === undefined) return; // no registry ⇒ default endpoints only (the pre-S9 behavior)
  let validatedFetch: FetchLike | undefined;
  for (const row of store.list()) {
    const id = KNOWN_PROVIDER_IDS.find((known) => known === row.name);
    if (id === undefined) continue; // a non-enum name (provider add enforces the closed enum) — ignore
    if (row.baseUrl === KNOWN_PROVIDERS[id].baseUrl) continue; // the default endpoint — keep the default adapter
    if (id !== 'openai' && id !== 'deepseek') continue; // custom base_url is openai-compatible only this round (§3)
    validatedFetch ??= options.validatedFetch ?? createValidatedFetch(); // built lazily, once, only when needed
    try {
      adapters[id] = createCustomOpenAiProvider({ providerId: id, baseURL: row.baseUrl, fetch: validatedFetch });
    } catch (err) {
      // A bad stored base_url (non-HTTPS / private / creds) — refuse the custom endpoint, keep the default adapter.
      if (!(err instanceof InvalidBaseUrlError)) throw err;
    }
  }
}
