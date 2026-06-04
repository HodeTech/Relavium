import { z } from 'zod';

import {
  URL_HAS_CREDENTIALS,
  kebabIdSchema,
  nonEmptyString,
  positiveInt,
  temperatureSchema,
} from './common.js';
import { LLM_PROVIDERS } from './constants.js';

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

/** Transient-error retry on the *same* model. */
export const RetrySchema = z
  .object({
    max: positiveInt,
    backoff: BackoffStrategySchema,
  })
  .strict();
export type Retry = z.infer<typeof RetrySchema>;

/** Transport for an agent-declared MCP server (mcp-integration.md). */
export const McpTransportSchema = z.enum(['stdio', 'sse', 'websocket']);

/** Allowed URL schemes for a network MCP server — never file:/javascript:/etc. */
const SAFE_MCP_URL = /^(https?|wss?):\/\//i;

/**
 * A reference to an MCP server an agent consumes (`McpServerRef`). The transport
 * dictates which connection field is required (mcp-integration.md): `stdio` needs a
 * `command`; `sse`/`websocket` need a `url`. Enforced at the contract boundary so a
 * mis-declared server is rejected at parse time, not at engine connect time.
 *
 * Intentionally distinct from the **config-level** `McpServerRegistrationSchema`
 * (config.ts), which *registers* a server by `name` with a `stdio | http` transport
 * (config-spec.md). These are separate contracts (agent consumption vs global
 * registration) and are kept apart on purpose rather than factored together.
 */
export const McpServerRefSchema = z
  .object({
    id: kebabIdSchema,
    transport: McpTransportSchema,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    tools_allowlist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (ref.transport === 'stdio' && !ref.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required for the 'stdio' transport",
        path: ['command'],
      });
    }
    if ((ref.transport === 'sse' || ref.transport === 'websocket') && !ref.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `url is required for the '${ref.transport}' transport`,
        path: ['url'],
      });
    }
    if (ref.url !== undefined) {
      // Per-transport scheme: `sse` is HTTP(S), `websocket` is WS(S) (stdio carries no url).
      // This also blocks file:/javascript:/etc. as a side effect.
      let schemeOk: boolean;
      if (ref.transport === 'websocket') schemeOk = /^wss?:\/\//i.test(ref.url);
      else if (ref.transport === 'sse') schemeOk = /^https?:\/\//i.test(ref.url);
      else schemeOk = SAFE_MCP_URL.test(ref.url);
      if (!schemeOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `url scheme is invalid for the '${ref.transport}' transport (sse → http(s), websocket → ws(s))`,
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
    tools: z.array(nonEmptyString).optional(),
    mcp_servers: z.array(McpServerRefSchema).optional(),
    memory: MemorySchema.optional(),
    retry: RetrySchema.optional(),
    fallback_chain: z.array(FallbackChainEntrySchema).optional(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    // MCP server ids must be unique within an agent (they namespace the registered tools).
    const ids = (agent.mcp_servers ?? []).map((server) => server.id);
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate mcp_servers id(s): ${duplicates.join(', ')}`,
        path: ['mcp_servers'],
      });
    }
  });
export type Agent = z.infer<typeof AgentSchema>;
