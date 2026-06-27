import { CliError } from '../process/errors.js';
import { KeychainUnavailableError, type KeychainStore } from './keychain.js';

/**
 * The **named-secret** resolver for inbound MCP servers (2.R Step 4, [ADR-0052](../../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §6).
 * A `{{secrets.<name>}}` placeholder in a server's `env` resolves through an **isolated** chain —
 * OS keychain account `mcp-secret:<name>` → `RELAVIUM_MCP_<NAME>` env var → fail-closed — and the value is
 * injected ONLY into the spawned child's environment, never into a committed file, a log, an event, or a
 * `--json` line.
 *
 * **Namespace isolation is load-bearing.** This resolver reads ONLY the `mcp-secret:*` keychain namespace and
 * `RELAVIUM_MCP_*` env vars — it can NEVER reach a provider-key account (`{providerId}:{keyId}`, e.g.
 * `anthropic:default`) or `RELAVIUM_<PROVIDER>_API_KEY`. Under the "a shared/imported workflow is the invite"
 * distribution model, this closes an exfil path: a hostile `env: { LEAK: '{{secrets.anthropic}}' }` in an
 * imported agent resolves `mcp-secret:anthropic` (a distinct, normally-empty account) — NOT the provider key —
 * so it cannot leak the real key into a malicious MCP server's environment (keychain-and-secrets.md §Entry naming).
 */

/** Resolve a named MCP secret to its value, or throw a typed, secret-free {@link CliError} when none is set. */
export type McpSecretResolver = (name: string) => string;

/** Valid secret-name charset — a conservative set that maps cleanly to both the keychain account and the env var. */
const SECRET_NAME = /^[A-Za-z0-9._-]+$/;

/** The keychain `account` for a named MCP secret — the **isolated** `mcp-secret:<name>` namespace (ADR-0052 §6). */
export function mcpSecretAccount(name: string): string {
  return `mcp-secret:${name}`;
}

/**
 * The env-var fallback for a named MCP secret — `RELAVIUM_MCP_<NAME>` (the name upper-cased, every non
 * `[A-Z0-9]` char → `_`). Mirrors the provider-key `RELAVIUM_<PROVIDER>_API_KEY` chain. NOTE: the normalization
 * is lossy (e.g. `gh-api` and `gh.api` both map to `RELAVIUM_MCP_GH_API`) — the precise source is the keychain
 * account; the env var is the headless/CI fallback.
 */
export function mcpSecretEnvVar(name: string): string {
  return `RELAVIUM_MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Build an {@link McpSecretResolver} over the **isolated** `mcp-secret:*` chain — keychain `mcp-secret:<name>` →
 * `RELAVIUM_MCP_<NAME>` env var → a fail-closed {@link CliError} (never echoing the secret value). The keychain
 * is **optional** so tests / headless runs stay keychain-free (env-only), exactly like the provider resolver; an
 * *unavailable* keychain backend (locked / no Secret Service) falls through to the env var (not a fault).
 */
export function createMcpSecretResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
  keychain?: KeychainStore,
): McpSecretResolver {
  return (name) => {
    if (!SECRET_NAME.test(name)) {
      // The name JUST failed the charset guard, so it may carry control bytes — NEVER echo it raw into a
      // terminal/log. Show a sanitized, length-bounded form (the same posture as the unknown-slash echo).
      const safe = name.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);
      throw new CliError(
        'invalid_invocation',
        `invalid MCP secret name '${safe}' — use only letters, digits, '.', '_' or '-'.`,
      );
    }
    // 1. OS keychain — the isolated `mcp-secret:<name>` account (NEVER a provider key). An unavailable backend
    //    falls through to the env var (the documented no-keychain path); any other error propagates.
    if (keychain !== undefined) {
      let fromKeychain: string | null = null;
      try {
        fromKeychain = keychain.get(mcpSecretAccount(name));
      } catch (err) {
        if (!(err instanceof KeychainUnavailableError)) throw err;
      }
      if (fromKeychain !== null && fromKeychain !== '') return fromKeychain;
    }
    // 2. Env var — the headless / CI fallback (also namespace-scoped to `RELAVIUM_MCP_*`).
    const fromEnv = env[mcpSecretEnvVar(name)];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    // 3. Fail-closed — a secret-free error naming both ways to provide it (never the value).
    throw new CliError(
      'invalid_invocation',
      `MCP secret '${name}' is not set — store it in the OS keychain (account ${mcpSecretAccount(name)}) ` +
        `or set ${mcpSecretEnvVar(name)}.`,
    );
  };
}
