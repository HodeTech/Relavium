import type { WorkflowDefinition } from '@relavium/core';
import type { EgressWorkOptions, ProviderStore } from '@relavium/db';
import {
  createCustomOpenAiProvider,
  defaultProviders,
  InvalidBaseUrlError,
  isRetryable,
  type EndpointKind,
  LlmProviderError,
  type LlmProvider,
  type LlmRequest,
  type ProviderId,
} from '@relavium/llm';
import type { Agent } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';
import {
  STANDARD_PROVIDER_KEY_ENV_VARS,
  type StandardEnvKeyName,
  type StandardEnvKeyPolicy,
} from './standard-env-policy.js';
import { createValidatedFetch, type FetchLike } from './validated-fetch.js';

/**
 * The CLI's provider seam (ADR-0038 host-injected resolution). `resolveProvider` returns the keyless
 * `@relavium/llm` adapter for an authored provider id; `keyFor` resolves that provider's API key through the
 * documented chain: **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` → eligible standard env → error** (the `secrets.enc`
 * encrypted-file fallback is deferred past v1.0 per keychain-and-secrets.md). Credentials are read afresh
 * per lookup; only `keyFor` returns a value, never an observation or renderer-facing state.
 *
 * Injectable so a test (and the 2.K regression harness) drives a stub provider + dummy key; the keychain is
 * an **optional** source so tests / the harness stay keychain-free (env-only) while production injects the
 * real `@napi-rs/keyring` store.
 */
export interface ProviderResolver {
  readonly resolveProvider: (id: ProviderId) => LlmProvider | undefined;
  readonly keyFor: (id: ProviderId) => string;
  /** Boolean-only per-lookup resolution; unexpected native faults propagate. */
  readonly hasKey?: (id: ProviderId) => boolean;
  /** Value-free observation. Sample on opening/key changes, never during rendering. */
  readonly availability?: (id: ProviderId) => ProviderKeyAvailability;
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
  /** Safe destination captured with the actual adapter; absent only on injected resolver stubs. */
  readonly endpointContext?: (id: ProviderId) => string;
}

/** Both native setup hosts disclose the resolver's pinned recipient, never a fresh registry read. */
export function providerEndpointContext(resolver: ProviderResolver, id: ProviderId): string {
  if (resolver.endpointContext !== undefined) return resolver.endpointContext(id);
  // Injected test/embedding resolvers may omit destination metadata. Production always supplies it.
  return resolver.endpointKind?.(id) === 'custom'
    ? 'Configured custom endpoint (origin unavailable).'
    : `Official endpoint: ${new URL(KNOWN_PROVIDERS[id].baseUrl).origin}`;
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

const RELAVIUM_PROVIDER_KEY_ENV_VARS = {
  anthropic: 'RELAVIUM_ANTHROPIC_API_KEY',
  openai: 'RELAVIUM_OPENAI_API_KEY',
  gemini: 'RELAVIUM_GEMINI_API_KEY',
  deepseek: 'RELAVIUM_DEEPSEEK_API_KEY',
} as const satisfies Readonly<Record<ProviderId, string>>;

type RelaviumKeyEnvName = (typeof RELAVIUM_PROVIDER_KEY_ENV_VARS)[ProviderId];
export type ProviderKeySource =
  | { readonly kind: 'keychain'; readonly label: 'OS keychain' }
  | { readonly kind: 'relavium-env'; readonly name: RelaviumKeyEnvName }
  | { readonly kind: 'standard-env'; readonly name: StandardEnvKeyName }
  | { readonly kind: 'injected'; readonly label: 'Injected resolver' };

/** Backend status is independent of usable env credentials. `unknown` is only for legacy injected stubs. */
export type KeychainHealth = 'available' | 'unavailable' | 'not-configured' | 'unknown';
type StandardEnvKeySource = Extract<ProviderKeySource, { readonly kind: 'standard-env' }>;
export type ProviderKeyAvailability = { readonly keychainHealth: KeychainHealth } & (
  | { readonly status: 'usable'; readonly source: ProviderKeySource }
  | { readonly status: 'missing' | 'unavailable' }
  | {
      readonly status: 'present-standard-not-allowed' | 'ineligible-custom-endpoint';
      readonly source: StandardEnvKeySource;
    }
);

/** Safe compatibility for existing injected resolver stubs whose source/backend are unknowable. */
export function providerKeyAvailability(
  resolver: Pick<ProviderResolver, 'keyFor' | 'hasKey' | 'availability'>,
  id: ProviderId,
): ProviderKeyAvailability {
  if (resolver.availability !== undefined) return resolver.availability(id);
  return providerHasKey(resolver, id)
    ? {
        status: 'usable',
        source: { kind: 'injected', label: 'Injected resolver' },
        keychainHealth: 'unknown',
      }
    : { status: 'missing', keychainHealth: 'unknown' };
}

/** The fixed Relavium variable, permitted directly on every endpoint. */
export function providerKeyEnvVar(id: ProviderId): RelaviumKeyEnvName {
  return RELAVIUM_PROVIDER_KEY_ENV_VARS[id];
}

export type CredentialSurface = 'home' | 'standalone-chat' | 'shell';

/** Fixed, value-free diagnostics with a remedy reachable in the actual host. */
export function providerKeyAvailabilityMessage(
  id: ProviderId,
  availability: ProviderKeyAvailability,
  surface: CredentialSurface = 'shell',
): string {
  const remedy =
    surface === 'home'
      ? 'open `/providers` to connect a key or review its source.'
      : surface === 'standalone-chat'
        ? 'restart `relavium chat` to open provider setup.'
        : `store one with \`relavium provider set-key ${id}\` or set ${providerKeyEnvVar(id)}.`;
  switch (availability.status) {
    case 'present-standard-not-allowed':
      return `${availability.source.name} is present but has not been allowed for this interactive invocation — ${remedy}`;
    case 'ineligible-custom-endpoint':
      return `${availability.source.name} cannot be used with this provider's custom endpoint — ${remedy}`;
    case 'unavailable':
      return `the OS keychain is unavailable and no usable API key exists for provider '${id}' — ${remedy}`;
    case 'missing':
      return `no API key for provider '${id}' — ${remedy}`;
    case 'usable':
      return `An API key is available from ${'name' in availability.source ? availability.source.name : availability.source.label}.`;
  }
}

/**
 * The actionable "no key" message: names both ways to provide one, never a key. One source for
 * {@link createProviderResolver}'s `keyFor` and the session pre-flight (MVP-A4), so the user reads the same
 * remedy whichever caught it first.
 */
export function missingKeyMessage(id: ProviderId): string {
  return providerKeyAvailabilityMessage(id, { status: 'missing', keychainHealth: 'unknown' });
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
 * Abort and the timeout bound the caller's probe observation. With a lifecycle owner, entered producer
 * work remains retained until its actual settlement; a UX timeout never acknowledges cleanup.
 * Ownership/admission refusals can reject instead of producing a validation result.
 */
export async function validateProviderKey(
  provider: LlmProvider,
  key: string,
  model: string,
  timeoutMs: number = VALIDATE_KEY_TIMEOUT_MS,
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly work: Required<Pick<EgressWorkOptions, 'retainWork'>>;
    readonly assertAdmitting: () => void;
  },
): Promise<ProviderKeyValidation> {
  lifecycle?.assertAdmitting();
  // Defensive: an empty key would make the redaction `raw.split('').join(keyHint(''))` split on every character
  // and garble the message (no secret leaks — the key is empty — but the detail becomes nonsense). All current
  // callers resolve a non-empty key (createProviderResolver rejects `''`); this closes the footgun at the seam.
  if (key.length === 0) {
    return { ok: false, detail: 'key test failed — (no key)', reason: 'other' };
  }
  const controller = new AbortController();
  let parentStopped: () => void = () => undefined;
  const stopped = new Promise<ProviderKeyValidation>((resolve) => {
    parentStopped = () => {
      controller.abort();
      resolve({ ok: false, detail: 'key test stopped', reason: 'network' });
    };
  });
  lifecycle?.signal.addEventListener('abort', parentStopped, { once: true });
  if (lifecycle?.signal.aborted === true) parentStopped();
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
  const probeFactory = async (): Promise<ProviderKeyValidation> => {
    lifecycle?.assertAdmitting();
    try {
      const request: LlmRequest = {
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        signal: controller.signal,
      };
      await (lifecycle === undefined
        ? provider.generate(request, key)
        : provider.generate(request, key, lifecycle.work));
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
  };
  try {
    // Register the real producer before entry. The UX timeout/abort result never retires it.
    const probe = lifecycle?.work.retainWork(probeFactory) ?? probeFactory();
    return await Promise.race([probe, timeout, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    lifecycle?.signal.removeEventListener('abort', parentStopped);
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
  /** Absent on scripting paths: eligible standard variables are used directly. Interactive hosts share one policy. */
  readonly standardEnvPolicy?: Pick<StandardEnvKeyPolicy, 'allows'>;
  readonly credentialSurface?: CredentialSurface;
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
  const officialContext = (id: ProviderId): string =>
    `Official endpoint: ${new URL(KNOWN_PROVIDERS[id].baseUrl).origin}`;
  const endpointContexts: Record<ProviderId, string> = {
    anthropic: officialContext('anthropic'),
    openai: officialContext('openai'),
    gemini: officialContext('gemini'),
    deepseek: officialContext('deepseek'),
  };
  // Endpoint identity comes from the same adapter factory that lowers the wire cap (ADR-0101).
  applyCustomEndpoints(adapters, options, endpointContexts);
  // A private key-bearing result never crosses the observation boundary. Every entry point uses the
  // same current-value resolution so consent cannot be bypassed by keyFor/hasKey or a replacement host.
  const resolveKey = (
    id: ProviderId,
  ): {
    readonly key?: string;
    readonly observation: ProviderKeyAvailability;
  } => {
    let keychainHealth: KeychainHealth = keychain === undefined ? 'not-configured' : 'available';
    if (keychain !== undefined) {
      let fromKeychain: string | null = null;
      try {
        fromKeychain = keychain.get(keychainAccount(id));
      } catch (err) {
        // Genuine backend unavailability permits env fallback. Unexpected native faults stay faults.
        if (!(err instanceof KeychainUnavailableError)) throw err;
        keychainHealth = 'unavailable';
      }
      if (fromKeychain !== null && fromKeychain !== '') {
        return {
          key: fromKeychain,
          observation: {
            status: 'usable',
            source: { kind: 'keychain', label: 'OS keychain' },
            keychainHealth,
          },
        };
      }
    }
    const relaviumName = providerKeyEnvVar(id);
    const fromEnv = env[relaviumName];
    if (fromEnv !== undefined && fromEnv !== '') {
      return {
        key: fromEnv,
        observation: {
          status: 'usable',
          source: { kind: 'relavium-env', name: relaviumName },
          keychainHealth,
        },
      };
    }
    const standardName = STANDARD_PROVIDER_KEY_ENV_VARS[id];
    const fromStandard = env[standardName];
    if (fromStandard !== undefined && fromStandard !== '') {
      const source: StandardEnvKeySource = { kind: 'standard-env', name: standardName };
      if (adapters[id].customEndpoint === true) {
        return { observation: { status: 'ineligible-custom-endpoint', source, keychainHealth } };
      }
      if (
        options.standardEnvPolicy !== undefined &&
        !options.standardEnvPolicy.allows(id, standardName)
      ) {
        return { observation: { status: 'present-standard-not-allowed', source, keychainHealth } };
      }
      return { key: fromStandard, observation: { status: 'usable', source, keychainHealth } };
    }
    return {
      observation: {
        status: keychainHealth === 'unavailable' ? 'unavailable' : 'missing',
        keychainHealth,
      },
    };
  };
  return {
    resolveProvider: (id) => adapters[id],
    endpointKind: (id) => (adapters[id].customEndpoint === true ? 'custom' : 'official'),
    endpointContext: (id) => endpointContexts[id],
    keyFor: (id) => {
      const result = resolveKey(id);
      if (result.key === undefined) {
        throw new CliError(
          'invalid_invocation',
          providerKeyAvailabilityMessage(id, result.observation, options.credentialSurface),
        );
      }
      return result.key;
    },
    hasKey: (id) => resolveKey(id).key !== undefined,
    availability: (id) => resolveKey(id).observation,
  };
}

/** One `providerStore.list()` row. Derived so no new import is needed. */
type StoredProviderRow = ReturnType<ProviderStore['list']>[number];

/**
 * Rebind a provider's adapter to a validated CUSTOM-endpoint adapter when its stored row carries a `base_url` that
 * differs from the known default (2.5.G S9, ADR-0065 §3–4). Only **OpenAI-compatible** (`openai`/`deepseek`) is
 * supported this round; `provider add` refuses a custom `base_url` on `anthropic`/`gemini`, so a stored one on them
 * shouldn't exist — skipped defensively. The custom endpoint's egress rides the host's **SSRF-validated fetch**
 * (`connectValidated`), and the adapter's construction-time `assertHttpsBaseUrl` (HTTPS + private-range + no-creds)
 * gate re-validates the URL. A `base_url` that fails that gate makes the provider **refuse every call** (`CR-80`)
 * rather than crashing resolver creation for EVERY command — the fail-fast refusal is at `provider add`; this is
 * the defensive net for a pre-S9 / tampered row.
 */
function applyCustomEndpoints(
  adapters: Record<ProviderId, LlmProvider>,
  options: ProviderResolverOptions,
  endpointContexts: Record<ProviderId, string>,
): void {
  const store = options.providerStore;
  if (store === undefined) return; // no registry ⇒ default endpoints only (the pre-S9 behavior)
  // Built lazily, ONCE, and only if a row actually needs it — memoized in this closure so a row-level helper can
  // reuse the same validated fetch without each row rebuilding it.
  let validatedFetch: FetchLike | undefined;
  const getValidatedFetch = (): FetchLike =>
    (validatedFetch ??= options.validatedFetch ?? createValidatedFetch());
  for (const row of store.list()) {
    applyCustomEndpointForRow(row, adapters, getValidatedFetch, endpointContexts);
  }
}

/** Rebind ONE stored row to a custom OpenAI-compatible adapter, or leave the default adapter standing. */
function applyCustomEndpointForRow(
  row: StoredProviderRow,
  adapters: Record<ProviderId, LlmProvider>,
  getValidatedFetch: () => FetchLike,
  endpointContexts: Record<ProviderId, string>,
): void {
  const id = KNOWN_PROVIDER_IDS.find((known) => known === row.name);
  if (id === undefined) return; // a non-enum name (provider add enforces the closed enum) — ignore
  const baseURL = row.baseUrl;
  if (baseURL === KNOWN_PROVIDERS[id].baseUrl) return; // the default endpoint — keep the default adapter
  if (id !== 'openai' && id !== 'deepseek') return; // custom base_url is openai-compatible only this round (§3)
  try {
    adapters[id] = createCustomOpenAiProvider({
      providerId: id,
      baseURL,
      fetch: getValidatedFetch(),
    });
    // Use the exact construction input, after the factory's admission/classification. Keeping this
    // private snapshot beside the adapter prevents a concurrent registry edit from changing its card.
    endpointContexts[id] =
      `${adapters[id].customEndpoint === true ? 'Custom' : 'Official'} endpoint: ${new URL(baseURL).origin}`;
  } catch (err) {
    // **A bad stored `base_url` fails CLOSED (`CR-80`).** This used to swallow the error and leave the DEFAULT
    // adapter standing, with a comment calling that "refuse the custom endpoint" — but the default adapter is
    // the OFFICIAL API. A user who pointed Relavium at an internal gateway, and whose stored row later drifted
    // to something non-HTTPS, private or credential-bearing, silently sent their prompts and their API key to
    // `api.openai.com` instead, with nothing on screen to say so. Falling back to the official endpoint is the
    // one outcome a rejected custom endpoint must never produce.
    //
    // Not a throw here: resolver construction runs for EVERY command, so throwing would make `relavium provider
    // list` — the command you would use to FIND the bad row — unusable. The provider becomes one that refuses
    // at the point of use instead, which is the earliest place the failure can be both loud and survivable.
    if (!(err instanceof InvalidBaseUrlError)) throw err;
    adapters[id] = refusingProvider(id, adapters[id], err);
    endpointContexts[id] = 'Custom endpoint configuration is invalid.';
  }
}

/**
 * A provider that refuses every call, standing in for one whose stored custom `base_url` was rejected (`CR-80`).
 *
 * `supports` is copied from the adapter it replaces rather than blanked: a capability flag is read to decide
 * whether to SEND tools or an image, and a blanked one would make a caller quietly drop the feature and then
 * succeed against a provider that was supposed to be unusable. Every path that matters ends at `generate` /
 * `stream`, and both throw.
 *
 * The message names the URL's SHAPE and never its value — `InvalidBaseUrlError` already summarises to
 * scheme+host, so an embedded `user:pass@` cannot survive into it — and it says which provider is refused and
 * how to fix the row. The optional seam methods are deliberately omitted: `contextLimit?` / `listModels?` /
 * `generateMedia?` are absent-means-unsupported, so a host degrades instead of crashing while enumerating.
 *
 * **Each arm fails the way its own signature promises**, which a first version got wrong by giving both the same
 * `(): never` thrower. `generate` is declared to return a `Promise`, so a caller may legitimately write
 * `.catch()` with no `try`; a synchronous throw escapes that and crashes the process instead of being handled —
 * a refusal that breaks the contract it is enforcing. It rejects instead. `stream` returns an `AsyncIterable`,
 * and a real adapter is an async generator whose failure surfaces at the first pull, so this mirrors that: the
 * call returns, and the error arrives where a `for await` is already positioned to catch it.
 */
function refusingProvider(
  id: ProviderId,
  replaced: LlmProvider,
  cause: InvalidBaseUrlError,
): LlmProvider {
  const refusal = (): InvalidBaseUrlError =>
    new InvalidBaseUrlError(
      cause.url,
      `${cause.reason} — refusing provider '${id}' rather than falling back to the official endpoint; fix or remove the stored base URL with \`relavium provider add ${id} --base-url <url>\``,
    );
  return {
    id,
    customEndpoint: true,
    supports: replaced.supports,
    generate: () => Promise.reject(refusal()),
    // An explicit `AsyncIterable` rather than an `async function*` that only throws: a generator with no
    // `yield` is a lint error, and silencing that would hide the fact that this iterable never yields — which
    // is the whole point of it. `next()` REJECTS, so the failure lands at the first pull, where a real
    // adapter's would, and a `for await` already sitting in a `try` catches it.
    stream: (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
        next: (): Promise<IteratorResult<never>> => Promise.reject(refusal()),
      }),
    }),
  };
}
