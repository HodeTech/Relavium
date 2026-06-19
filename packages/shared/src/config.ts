import { z } from 'zod';

import { URL_HAS_CREDENTIALS, nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import { FS_SCOPE_TIERS, ON_EXCEED_ACTIONS } from './constants.js';

/**
 * Configuration schemas (config-spec.md). Validation only — no file IO. The global
 * `config.toml` and the per-project `project.toml` / `workspace.toml` are stable,
 * versioned, committed formats; the per-project layer overrides the global one.
 */

export const UpdateChannelSchema = z.enum(['stable', 'beta']);

/** Filesystem permission tier (built-in-tools.md) — derived from the shared tier vocabulary. */
export const FsScopeSchema = z.enum(FS_SCOPE_TIERS);

/** A registered `http` MCP server must use http(s) — never file:/javascript:/etc. */
const SAFE_HTTP_URL = /^https?:\/\//i;

/**
 * An MCP server registration (`[[mcp_servers]]`). The transport dictates the required
 * connection field: `stdio` needs a `command`; `http` needs a `url`.
 */
export const McpServerRegistrationSchema = z
  .object({
    name: nonEmptyString,
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    autostart: z.boolean().optional(),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  // .strict(): a typo in a committed MCP key (e.g. `autostrat`) fails loudly — strict config per ADR-0033 (which amends ADR-0023's config carve-out).
  .strict()
  .superRefine((server, ctx) => {
    if (server.transport === 'stdio' && !server.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required for the 'stdio' transport",
        path: ['command'],
      });
    }
    if (server.transport === 'http' && !server.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url is required for the 'http' transport",
        path: ['url'],
      });
    }
    // SSRF guard: a registered url must be http(s) — reject file:, javascript:, etc.
    if (server.url !== undefined && !SAFE_HTTP_URL.test(server.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url must use http or https',
        path: ['url'],
      });
    }
    // Secret hygiene: no credentials embedded in a git-committed url.
    if (server.url !== undefined && URL_HAS_CREDENTIALS.test(server.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url must not embed credentials (user:pass@…) — use env/keychain auth',
        path: ['url'],
      });
    }
  });

/** `~/.relavium/config.toml` — global preferences + MCP registrations.
 *  `.strict()`: a typo in a committed config key fails loudly rather than being silently dropped —
 *  config files are strict too per ADR-0033 (which amends ADR-0023's config carve-out). */
export const GlobalConfigSchema = z
  .object({
    update_channel: UpdateChannelSchema.optional(),
    preferences: z
      .object({
        default_model: z.string().optional(),
        theme: z.string().optional(),
      })
      .strict()
      .optional(),
    mcp_servers: z.array(McpServerRegistrationSchema).optional(),
  })
  .strict();
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * Chat-mode (`[chat]`) defaults for the agent-first entry point (config-spec.md, ADR-0024).
 * Distinct from `[defaults]` (which governs workflow runs); a chat session reuses the workflow
 * `allowedCommands` policy (not re-declared here) and may carry its own pre-egress cost cap
 * (`max_cost_microcents` + `on_exceed`) enforced by the same governor as a workflow budget (ADR-0028).
 */
export const ChatConfigSchema = z
  .object({
    default_model: z.string().optional(),
    fs_scope: FsScopeSchema.optional(),
    max_messages: positiveInt.optional(), // session-history cap before older turns are trimmed
    max_cost_microcents: nonNegativeInt.optional(), // 0/absent = unbounded; >0 = per-session cap
    on_exceed: z.enum(ON_EXCEED_ACTIONS).optional(),
  })
  .strict() // fail loud on an unknown [chat] key (strict config — ADR-0033, amends ADR-0023)
  .optional();

/**
 * Per-modality media-output **unit-count** default for the pre-egress media cost estimate (1.AF/D17,
 * [ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md) §3) — the analogue of
 * `max_tokens_estimate`, but a **count** not a price: how many billed units (images, audio-seconds,
 * video-seconds) a media-output turn is assumed to produce when it does not declare its own volume. The
 * per-unit **price** lives in the model catalog (`ModelPricing.mediaOutputRates`), never here. `document`
 * is absent (PDF bills as tokens, never a chat-turn output — the billed set is image/audio/video).
 */
export const MediaCostEstimateSchema = z
  .object({
    image: nonNegativeInt.optional(), // assumed images per media-output turn
    audio: nonNegativeInt.optional(), // assumed audio-seconds per media-output turn
    video: nonNegativeInt.optional(), // assumed video-seconds per media-output turn
  })
  .strict();
export type MediaCostEstimate = z.infer<typeof MediaCostEstimateSchema>;

/** `project.toml` / `workspace.toml` — project defaults, variables, project-scoped MCP, chat defaults. */
export const ProjectConfigSchema = z
  .object({
    defaults: z
      .object({
        model: z.string().optional(),
        fs_scope: FsScopeSchema.optional(),
        // Per-call output-token estimate the pre-egress budget governor uses when a node/session
        // omits maxTokens (ADR-0028) — not the model's absolute max, which would over-block.
        max_tokens_estimate: positiveInt.optional(),
        // Per-modality media-output unit-count default for the pre-egress media cost estimate (1.AF/D17).
        media_cost_estimate: MediaCostEstimateSchema.optional(),
      })
      .strict()
      .optional(),
    variables: z.record(z.string(), z.string()).optional(),
    chat: ChatConfigSchema,
    // Project-scoped MCP registrations merge with the global ones (config-spec.md §resolution).
    mcp_servers: z.array(McpServerRegistrationSchema).optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
