import { z } from 'zod';

import { kebabIdSchema, nonEmptyString, positiveInt } from './common.js';
import { LLM_PROVIDERS } from './constants.js';

/**
 * Agent schema (agent-yaml-spec.md). An agent is a named, reusable LLM
 * configuration: model, provider, system prompt, generation params, tools, and
 * resilience (retry + multi-provider fallback). Validated by `AgentSchema`.
 *
 * Agents never contain API keys — provider credentials resolve from the secret
 * store at call time and are never schema-representable.
 */

/** The supported provider id (the `LLMProvider` seam's closed set). */
export const ProviderSchema = z.enum(LLM_PROVIDERS);

/** Backoff curve for `retry` and for engine-side retry config. */
export const BackoffStrategySchema = z.enum(['linear', 'exponential']);

/** Transient-error retry on the *same* model. */
export const RetrySchema = z.object({
  max: positiveInt,
  backoff: BackoffStrategySchema,
});
export type Retry = z.infer<typeof RetrySchema>;

/** Transport for an agent-declared MCP server (mcp-integration.md). */
export const McpTransportSchema = z.enum(['stdio', 'sse', 'websocket']);

/** A reference to an MCP server an agent consumes (`McpServerRef`). */
export const McpServerRefSchema = z.object({
  id: kebabIdSchema,
  transport: McpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  tools_allowlist: z.array(nonEmptyString).optional(),
});
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

/** Conversational memory policy. */
export const MemorySchema = z.object({
  type: z.enum(['none', 'window', 'summary']),
  window_size: positiveInt.optional(),
});

/** One ordered alternate tried after the primary model is exhausted. */
export const FallbackChainEntrySchema = z.object({
  model: nonEmptyString,
  provider: ProviderSchema,
  max_attempts: positiveInt,
});
export type FallbackChainEntry = z.infer<typeof FallbackChainEntrySchema>;

/** A reusable agent definition (`.agent.yaml` or an inline `agents:` entry). */
export const AgentSchema = z.object({
  id: kebabIdSchema,
  name: z.string().optional(),
  description: z.string().optional(),
  model: nonEmptyString,
  provider: ProviderSchema,
  system_prompt: nonEmptyString,
  temperature: z.number().optional(),
  max_tokens: positiveInt.optional(),
  tools: z.array(nonEmptyString).optional(),
  mcp_servers: z.array(McpServerRefSchema).optional(),
  memory: MemorySchema.optional(),
  retry: RetrySchema.optional(),
  fallback_chain: z.array(FallbackChainEntrySchema).optional(),
});
export type Agent = z.infer<typeof AgentSchema>;
