import type { WorkflowDefinition } from '@relavium/core';
import { defaultProviders, type LlmProvider, type ProviderId } from '@relavium/llm';
import type { Agent } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';

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
}

/** The env var holding a provider's API key — the headless per-invocation key source (CI / no-keychain). */
export function providerKeyEnvVar(id: ProviderId): string {
  return `RELAVIUM_${id.toUpperCase()}_API_KEY`;
}

/** A non-secret display hint for a key — masked, with the last 4 chars (or fully masked when too short). NEVER the full key. */
export function keyHint(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

/** A known provider's metadata — display name, base URL, and a cheap model for the live key test. */
export interface ProviderMeta {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly testModel: string;
}

/**
 * The known providers (each has an `@relavium/llm` adapter). The single home for provider metadata — the
 * `relavium provider` command (add / test) and the `/doctor --deep` key probe both read it, so a new provider's
 * test model is defined once.
 */
export const KNOWN_PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    testModel: 'claude-haiku-4-5',
  },
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    testModel: 'gpt-5.4-mini',
  },
  gemini: {
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    testModel: 'gemini-2.5-flash',
  },
  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    testModel: 'deepseek-chat',
  },
};

/** The provider ids the CLI knows how to validate (those with a test model) — the typed key set of
 *  {@link KNOWN_PROVIDERS}. `Object.keys` widens to `string[]`, so the single narrowing cast lives HERE,
 *  documented; the keys ARE `ProviderId`s because the record is typed `Record<ProviderId, …>`. The `/doctor`
 *  provider probe iterates this instead of casting `Object.keys` at the use site. */
export const KNOWN_PROVIDER_IDS: readonly ProviderId[] = Object.keys(KNOWN_PROVIDERS) as ProviderId[];

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

export function createProviderResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
  keychain?: KeychainStore,
): ProviderResolver {
  // Keyless adapters built once and reused; the key is injected per call via `keyFor`. The
  // provider→adapter mapping lives in the seam package (`@relavium/llm`), not here.
  const adapters = defaultProviders();
  return {
    resolveProvider: (id) => adapters[id],
    keyFor: (id) => {
      // 1. OS keychain (the primary store, 2.C). Absent (`null`) → fall through to env; an *unavailable*
      //    backend (locked / no Secret Service) also falls through — the env var is the CLI's documented
      //    no-keychain path. We never read/write a plaintext fallback.
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
      // 3. No source — a clean invocation error naming both ways to provide the key (never the key itself).
      throw new CliError(
        'invalid_invocation',
        `no API key for provider '${id}' — store one with \`relavium provider set-key ${id}\` or set ${providerKeyEnvVar(id)}.`,
      );
    },
  };
}
