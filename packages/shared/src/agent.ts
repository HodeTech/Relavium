import { z } from 'zod';

import {
  URL_HAS_CREDENTIALS,
  findDuplicates,
  jsonSchemaMetadataSchema,
  kebabIdSchema,
  nonEmptyString,
  positiveInt,
  temperatureSchema,
} from './common.js';
import { LLM_PROVIDERS, RETRYABLE_ERROR_CODES } from './constants.js';

/**
 * Agent schema (agent-yaml-spec.md). An agent is a named, reusable LLM
 * configuration: model, provider, system prompt, generation params, tools, and
 * resilience (retry + multi-provider fallback). Validated by `AgentSchema`.
 *
 * Agents never contain API keys — provider credentials resolve from the secret
 * store at call time and are never schema-representable.
 *
 * Every authored object is `.strict()`: an unknown or mistyped key is a validation
 * error, not a silently stripped field (ADR-0023).
 */

/** The supported provider id (the `LLMProvider` seam's closed set). */
export const ProviderSchema = z.enum(LLM_PROVIDERS);

/** Backoff curve for `retry` and for engine-side retry config. */
export const BackoffStrategySchema = z.enum(['linear', 'exponential']);
export type BackoffStrategy = z.infer<typeof BackoffStrategySchema>;

/**
 * A node's transient-failure **retry budget**, applied by the engine ABOVE the provider fallback chain
 * ([ADR-0040](../decisions/0040-node-retry-budget-above-the-chain.md)): on a retryable failure the *whole node*
 * is re-dispatched up to `max` **total attempts** (the initial attempt counts), with `backoff` over a
 * `backoff_ms` base. **Not** the within-chain same-model retry it once configured (ADR-0038, amended). On an
 * `agent` node this also defaults the agent's value (`node.retry ?? agent.retry`).
 */
export const RetrySchema = z
  .object({
    /** Total attempts, including the first (`max: 3` ⇒ the initial attempt + up to 2 re-dispatches). */
    max: positiveInt,
    /** How the inter-attempt delay grows: `linear` (`base * n`) or `exponential` (`base * 2^(n-1)`). */
    backoff: BackoffStrategySchema,
    /** The backoff base delay in ms the strategy scales; the engine defaults it when omitted (ADR-0040 A.3). */
    backoff_ms: positiveInt.optional(),
    /**
     * Restrict which retryable failures consume the budget — restricted to the retryable subset
     * ({@link RETRYABLE_ERROR_CODES}), so a non-retryable code (e.g. `tool_denied`) is rejected at parse
     * (ADR-0040 A.4), never a silent no-op. Omitted ⇒ any `retryable` failure is retried.
     */
    retry_on: z.array(z.enum(RETRYABLE_ERROR_CODES)).min(1).optional(),
  })
  .strict();
export type Retry = z.infer<typeof RetrySchema>;

/**
 * Transport for an agent-declared MCP server (mcp-integration.md), reconciled to the current MCP spec
 * ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §5): `http` is the
 * **Streamable HTTP** transport (the SDK's `StreamableHTTPClientTransport`); `sse` is a **deprecated alias**
 * of `http` (the legacy HTTP+SSE transport, accepted for older servers). Both schemas (this + the config
 * `McpServerRegistrationSchema`) converge on `stdio | http | websocket`.
 */
export const McpTransportSchema = z.enum(['stdio', 'http', 'websocket', 'sse']);

/** Allowed URL schemes for a network MCP server — never file:/javascript:/etc. */
const SAFE_MCP_URL = /^(https?|wss?):\/\//i;

/** The inline connection fields a by-name `ref` must NOT carry (the registration provides them). */
const INLINE_CONNECTION_FIELDS = [
  'id',
  'transport',
  'command',
  'args',
  'env',
  'url',
  'allow_local_endpoint',
] as const;

/**
 * A reference to an MCP server an agent consumes (`McpServerRef`) — one of two mutually-exclusive forms
 * ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §5):
 *
 * - **Inline**: a self-contained `{ id, transport, … }` where the transport dictates the required connection
 *   field — `stdio` needs a `command`; `http`/`sse`/`websocket` need a `url`.
 * - **By-name `ref`**: `{ ref: <registration-name>, tools_allowlist? }` — identity AND connection come from a
 *   config `[[mcp_servers]]` registration (config.ts), so the inline `id`/`transport`/`command`/`url`/`env`
 *   fields are forbidden (the registration provides them). This realizes "register once, reference from many
 *   agents"; the host resolves the `ref` against the merged config at connect time.
 *
 * Enforced at the contract boundary so a mis-declared server is rejected at parse time, not at engine connect time.
 */
export const McpServerRefSchema = z
  .object({
    id: kebabIdSchema.optional(),
    transport: McpTransportSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    // Opt into a private/loopback network endpoint (ADR-0053 §3), scoped to the declared host:port — relaxes the
    // SSRF range-block AND permits plaintext for THAT local endpoint only. Network transports only.
    allow_local_endpoint: z.boolean().optional(),
    ref: nonEmptyString.optional(),
    tools_allowlist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    // The by-name `ref` form: identity + connection come from the registration; inline fields are forbidden.
    if (ref.ref !== undefined) {
      for (const field of INLINE_CONNECTION_FIELDS) {
        if (ref[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `'${field}' is not allowed with 'ref' — the [[mcp_servers]] registration provides it`,
            path: [field],
          });
        }
      }
      return;
    }
    // The inline form: `id` + `transport` are required (a `ref` is the only way to omit them).
    if (ref.id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "an inline server requires 'id' (or use 'ref' to reference a [[mcp_servers]] registration)",
        path: ['id'],
      });
    }
    if (ref.transport === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an inline server requires 'transport' (or use 'ref')",
        path: ['transport'],
      });
      return; // the per-transport checks below need a transport
    }
    if (ref.transport === 'stdio') {
      if (!ref.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "command is required for the 'stdio' transport",
          path: ['command'],
        });
      }
      // A stdio server has no `url` — reject a stray one (a mis-declared server fails at parse, secure-by-default).
      if (ref.url !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url is not used by the 'stdio' transport",
          path: ['url'],
        });
      }
      // `allow_local_endpoint` is a network-only SSRF opt-in — reject it on stdio (mirrors the `url` guard).
      if (ref.allow_local_endpoint !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "allow_local_endpoint is not used by the 'stdio' transport (network transports only)",
          path: ['allow_local_endpoint'],
        });
      }
    }
    if (ref.transport !== 'stdio' && !ref.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `url is required for the '${ref.transport}' transport`,
        path: ['url'],
      });
    }
    if (ref.url !== undefined) {
      // Per-transport scheme: `http`/`sse` are HTTP(S), `websocket` is WS(S) (stdio carries no url).
      // This also blocks file:/javascript:/etc. as a side effect.
      let schemeOk: boolean;
      if (ref.transport === 'websocket') schemeOk = /^wss?:\/\//i.test(ref.url);
      else if (ref.transport === 'http' || ref.transport === 'sse')
        schemeOk = /^https?:\/\//i.test(ref.url);
      else schemeOk = SAFE_MCP_URL.test(ref.url);
      if (!schemeOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `url scheme is invalid for the '${ref.transport}' transport (http/sse → http(s), websocket → ws(s))`,
          path: ['url'],
        });
      }
      // Secret hygiene: no credentials embedded in a git-committed url.
      if (URL_HAS_CREDENTIALS.test(ref.url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'url must not embed credentials (user:pass@…) — use env/keychain auth',
          path: ['url'],
        });
      }
    }
  });
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

/**
 * Conversational memory policy. Modeled as a discriminated union so that the retention
 * depth (`window_size`) is required exactly when `type` is `window` (agent-yaml-spec.md):
 * `none`/`summary` carry no depth; `window` must specify one.
 */
export const MemorySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('summary') }).strict(),
  z.object({ type: z.literal('window'), window_size: positiveInt }).strict(),
]);
export type Memory = z.infer<typeof MemorySchema>;

/** One ordered alternate tried after the primary model is exhausted. */
export const FallbackChainEntrySchema = z
  .object({
    model: nonEmptyString,
    provider: ProviderSchema,
    max_attempts: positiveInt,
  })
  .strict();
export type FallbackChainEntry = z.infer<typeof FallbackChainEntrySchema>;

/** A reusable agent definition (`.agent.yaml` or an inline `agents:` entry). */
export const AgentSchema = z
  .object({
    id: kebabIdSchema,
    name: z.string().optional(),
    description: z.string().optional(),
    model: nonEmptyString,
    provider: ProviderSchema,
    system_prompt: nonEmptyString,
    temperature: temperatureSchema.optional(), // provider-agnostic [0, 2] (common.ts)
    max_tokens: positiveInt.optional(),
    // Optional agent-level JSON-Schema metadata (agent-yaml-spec.md) — the engine validates
    // turn I/O against these when present; absent on most agents.
    input_schema: jsonSchemaMetadataSchema.optional(),
    output_schema: jsonSchemaMetadataSchema.optional(),
    tools: z.array(nonEmptyString).optional(),
    mcp_servers: z.array(McpServerRefSchema).optional(),
    memory: MemorySchema.optional(),
    retry: RetrySchema.optional(),
    fallback_chain: z.array(FallbackChainEntrySchema).optional(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    // MCP server identities must be unique within an agent (they namespace the registered tools). The identity
    // here is the EXACT inline `id` or by-name `ref` registration name. This catches the common exact-duplicate
    // case at parse; a host-side *sanitization* collision (two distinct free-form registration names that map to
    // the same namespace segment, e.g. `a.b` and `a b`) is NOT visible to the schema and is caught fail-loud at
    // discovery instead (ADR-0052 §4 — the manager's duplicate-id/collision guards). (The `superRefine` on each
    // ref guarantees exactly one of `ref`/`id` is present; the filter only narrows the type for TS.)
    const ids = (agent.mcp_servers ?? [])
      .map((server) => server.ref ?? server.id)
      .filter((identity): identity is string => identity !== undefined);
    const duplicates = findDuplicates(ids);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate mcp_servers id(s): ${duplicates.join(', ')}`,
        path: ['mcp_servers'],
      });
    }
  });
export type Agent = z.infer<typeof AgentSchema>;
