import type { WorkflowDefinition } from '@relavium/core';
import type { ProviderStore } from '@relavium/db';
import {
  createCustomOpenAiProvider,
  defaultProviders,
  InvalidBaseUrlError,
  isRetryable,
  type EndpointKind,
  LlmProviderError,
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
   * Used by the `/models` picker to gate a keyless provider's models and by `isProviderKeyless`. Identical
   * resolution to {@link keyFor}: a keychain key OR the env fallback ⇒ `true`, else `false`. A **locked /
   * unavailable** keychain is a `KeychainUnavailableError` that (like `keyFor`) falls through to env and is treated
   * as absence — so with no env key it returns `false` (correct: the provider genuinely can't be called). Only a
   * NON-`KeychainUnavailableError` native binding fault propagates — but the production `createOsKeychainStore`
   * wraps every native error into `KeychainUnavailableError`, so in practice nothing propagates. OPTIONAL so a test
   * stub can implement `keyFor` alone — consumers go through {@link providerHasKey}, which falls back to a `keyFor`
   * probe when this is absent; the real {@link createProviderResolver} always provides it, so production never falls back.
   */
  readonly hasKey?: (id: ProviderId) => boolean;
  /**
   * Is this provider talking to its OWN API, or to a custom `base_url`
   * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §7)?
   *
   * The adapter clamps an authored `max_tokens` to the model's published ceiling on an official endpoint and
   * deliberately does NOT on a custom one — a gateway may serve anything under a familiar model id. The pre-egress
   * ESTIMATE has to make the same call, or it stops describing the request that is about to be sent: treat a
   * gateway as official and the estimate lands below what the wire can spend, so the budget governor
   * under-authorizes and waves through a call it should have stopped.
   *
   * Decided by HOST, not by "is there a stored row": a user who registers OpenAI with its own endpoint spelled out
   * is still on the official API, however they spell it. OPTIONAL so a test stub can omit it; absent ⇒ official.
   */
  readonly endpointKind?: (id: ProviderId) => EndpointKind;
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
 * The known providers (each has an `@relavium/llm` adapter). The single home for CLI provider metadata:
 * `displayName`, `baseUrl`, a cheap `testModel` for the live key-check, and the public `pricingUrl`. Every
 * provider-facing CLI surface is **data-driven off this map + {@link KNOWN_PROVIDER_IDS}** — registering a provider
 * here (plus its `LLM_PROVIDERS` id — see below) lights up every surface with **no per-surface edit**, via one of
 * two access patterns:
 *  - **Iterate `KNOWN_PROVIDER_IDS`** (enumerate every known provider): the first-run onboarding **wizard**
 *    ([onboarding/wizard.ts](../onboarding/wizard.ts)), the `/doctor --deep` key probe, and the `/models` Home
 *    key-gate ([drive-home.tsx](../home/drive-home.tsx)). A provider absent from `KNOWN_PROVIDER_IDS` is simply
 *    invisible / mis-dimmed here (see the {@link KNOWN_PROVIDER_IDS} lock-step note).
 *  - **Validate one supplied id, then index `KNOWN_PROVIDERS[id]`** for its metadata: `relavium provider add` /
 *    `set-key` / `remove-key` / `test`, which accept a single name gated by the WIDER `ProviderIdSchema`
 *    (`z.enum(LLM_PROVIDERS)`) — so an `LLM_PROVIDERS` id absent from `KNOWN_PROVIDERS` would pass validation and
 *    then throw on the `undefined` metadata lookup (the second reason the two lists must stay in lock-step).
 * A new provider's test model / display name is thus defined once. See the `add-llm-adapter` skill for the
 * end-to-end checklist.
 */
/** The provider ids the CLI knows how to validate + onboard (those with a `testModel`). The const tuple is the
 *  SOURCE OF TRUTH — `satisfies readonly ProviderId[]` validates each is a real `ProviderId` (no cast, no
 *  widening), and {@link KNOWN_PROVIDERS} is keyed on it, so THOSE two cannot drift; the wizard, `provider`, and
 *  `/doctor` probe all iterate it directly.
 *
 *  LOCK-STEP with `LLM_PROVIDERS` (`@relavium/shared` — the canonical closed `ProviderId` enum): the `satisfies`
 *  above only enforces `KNOWN_PROVIDER_IDS ⊆ LLM_PROVIDERS`. The REVERSE is NOT compiler-checked — a provider
 *  added to `LLM_PROVIDERS` (so a live/static `model_catalog` row can exist for it) but MISSING here is silently
 *  mis-dimmed in the Home: the key-probe ([drive-home.tsx](../home/drive-home.tsx)) filters `KNOWN_PROVIDER_IDS`,
 *  so the new provider is never in `keyedProviders`, and `mergeModelCatalog` marks its models `available: false` +
 *  `unavailableReason: 'no-key'` EVEN WITH a stored key (the 2.5.G Step-A latent coupling). The `provider`
 *  commands (`add`/`set-key`/`test`), whose id-validation accepts the wider `LLM_PROVIDERS`, would instead throw on
 *  the `undefined` `KNOWN_PROVIDERS[id]` metadata lookup. A guard test (`providers.test.ts`) pins the two as equal
 *  sets, so a missed registration is a red CI run — not either runtime failure. */
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

/**
 * Why a {@link validateProviderKey} probe ended — so a caller can branch on the CAUSE, not by string-matching
 * `detail` (2.5.G S8 wizard). `'auth'` — the key was rejected (a bad key; retrying with a new key is the remedy);
 * `'network'` — a timeout / transport / overloaded / rate-limit (offline/transient; "continue anyway" is the sane
 * default so an offline first-run isn't blocked); `'other'` — a non-auth request fault or an unexpected throw.
 * Sourced from the seam's own `LlmProviderError.llmError.kind`, never a heuristic — a Relavium classification, not
 * a message; it carries no provider text.
 */
export type ValidationReason = 'ok' | 'auth' | 'network' | 'other';

/**
 * The outcome of a {@link validateProviderKey} probe — a DISCRIMINATED union so `reason` is pinned to `ok` at the
 * type level (the "typed, discriminated" standard): success is always `reason: 'ok'`; a failure is never `'ok'`.
 * `detail` is secret-free (`key works (<model>)` on success, `key test failed — <redacted>` on failure).
 */
export type ProviderKeyValidation =
  | { readonly ok: true; readonly detail: string; readonly reason: 'ok' }
  | {
      readonly ok: false;
      readonly detail: string;
      readonly reason: Exclude<ValidationReason, 'ok'>;
    };

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
    return { ok: false, detail: 'key test failed — (no key)', reason: 'other' };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderKeyValidation>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        detail: `key test failed — timeout (${timeoutMs}ms)`,
        reason: 'network',
      });
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
      return { ok: true, detail: `key works (${model})`, reason: 'ok' };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        detail: `key test failed — ${raw.split(key).join(keyHint(key))}`,
        // Classify from the seam's own error kind (never a string heuristic): a rejected key is `auth` (retry with
        // a new key); a timeout/transport/overloaded/rate-limit is `network` (continue-anyway is sane); else `other`.
        reason: classifyValidationFailure(err),
      };
    }
  })();
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Map a probe throw → a {@link ValidationReason}, from the seam's `LlmProviderError.llmError.kind` (never a string
 *  heuristic). A non-`LlmProviderError` is `'other'`. The `'network'` (continue-anyway) bucket IS exactly the seam's
 *  RETRYABLE (transient) set — bound to `isRetryable` so a new transient kind can't drift out of it. No text read. */
function classifyValidationFailure(err: unknown): Exclude<ValidationReason, 'ok'> {
  if (!(err instanceof LlmProviderError)) return 'other';
  const kind = err.llmError.kind;
  if (kind === 'auth') return 'auth'; // a rejected key — re-entering is the remedy
  return isRetryable(kind) ? 'network' : 'other'; // transient (timeout/transport/overloaded/rate_limit) ⇒ network
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
  // The provider ids that ended up pointed at a GENUINELY different host — not merely at a differently-spelled
  // official one. Feeds `endpointKind`, which the pre-egress estimate reads (ADR-0071 §7).
  const customEndpoints = new Set<ProviderId>();
  applyCustomEndpoints(adapters, options, customEndpoints);
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
    endpointKind: (id) => (customEndpoints.has(id) ? 'custom' : 'official'),
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
    // Boolean-only (never the key). Same resolution as `keyFor`: a locked/unavailable keychain (a
    // `KeychainUnavailableError`) falls through to env, so with no env key it is `false` (correct — uncallable);
    // only a non-`KeychainUnavailableError` native fault propagates via `resolveKey` (the production store never
    // raises one, so nothing propagates in practice).
    hasKey: (id) => resolveKey(id) !== undefined,
  };
}

/**
 * Is this stored `base_url` a host OTHER than the provider's own API?
 *
 * By HOST, never by string: the CLI stores a `--base-url` VERBATIM, so `https://api.openai.com/v1/` (one trailing
 * slash) and `https://api.openai.com/v1` are different strings for the same API. Mirrors `endpointKindFor` inside
 * the adapter, which decides the same question for the wire — the two must agree, or the estimate stops describing
 * the request. A trailing-dot FQDN (`api.openai.com.`) is the same host too, and DNS says so.
 */
function isCustomHost(id: ProviderId, baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
    return host !== new URL(KNOWN_PROVIDERS[id].baseUrl).hostname.toLowerCase();
  } catch {
    return true; // unparseable ⇒ treat as custom (the conservative side: no clamp, no dialect switch)
  }
}

/** One `providerStore.list()` row. Derived so no new import is needed. */
type StoredProviderRow = ReturnType<ProviderStore['list']>[number];

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
  custom: Set<ProviderId>,
): void {
  const store = options.providerStore;
  if (store === undefined) return; // no registry ⇒ default endpoints only (the pre-S9 behavior)
  // Built lazily, ONCE, and only if a row actually needs it — memoized in this closure so a row-level helper can
  // reuse the same validated fetch without each row rebuilding it.
  let validatedFetch: FetchLike | undefined;
  const getValidatedFetch = (): FetchLike =>
    (validatedFetch ??= options.validatedFetch ?? createValidatedFetch());
  for (const row of store.list()) {
    applyCustomEndpointForRow(row, adapters, custom, getValidatedFetch);
  }
}

/** Rebind ONE stored row to a custom OpenAI-compatible adapter, or leave the default adapter standing. */
function applyCustomEndpointForRow(
  row: StoredProviderRow,
  adapters: Record<ProviderId, LlmProvider>,
  custom: Set<ProviderId>,
  getValidatedFetch: () => FetchLike,
): void {
  const id = KNOWN_PROVIDER_IDS.find((known) => known === row.name);
  if (id === undefined) return; // a non-enum name (provider add enforces the closed enum) — ignore
  if (row.baseUrl === KNOWN_PROVIDERS[id].baseUrl) return; // the default endpoint — keep the default adapter
  if (id !== 'openai' && id !== 'deepseek') return; // custom base_url is openai-compatible only this round (§3)
  try {
    adapters[id] = createCustomOpenAiProvider({
      providerId: id,
      baseURL: row.baseUrl,
      fetch: getValidatedFetch(),
    });
    // Record it for the pre-egress estimate (ADR-0071 §7) — by HOST, so a row that merely SPELLS the official
    // endpoint differently (a trailing slash, a missing `/v1`) is not mistaken for a gateway. The adapter makes
    // the same call for the wire; this keeps the estimate describing the request the adapter will send.
    if (isCustomHost(id, row.baseUrl)) custom.add(id);
  } catch (err) {
    // A bad stored base_url (non-HTTPS / private / creds) — refuse the custom endpoint, keep the default adapter.
    if (!(err instanceof InvalidBaseUrlError)) throw err;
  }
}
