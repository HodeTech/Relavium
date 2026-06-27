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

/** A registered network MCP server must use http(s) (`http`) or ws(s) (`websocket`) — never file:/javascript:/etc. */
const SAFE_HTTP_URL = /^https?:\/\//i;
const SAFE_WS_URL = /^wss?:\/\//i;

/**
 * An MCP server registration (`[[mcp_servers]]`). The transport dictates the required connection field:
 * `stdio` needs a `command`; `http` (Streamable HTTP) / `websocket` need a `url`. Reconciled with the agent
 * `McpServerRefSchema` to one vocabulary — `stdio | http | websocket`
 * ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §5).
 */
export const McpServerRegistrationSchema = z
  .object({
    name: nonEmptyString,
    transport: z.enum(['stdio', 'http', 'websocket']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    autostart: z.boolean().optional(),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).optional(),
    // Opt into a private/loopback network endpoint (ADR-0053 §3) — see `McpServerRefSchema`. Network transports only.
    allow_local_endpoint: z.boolean().optional(),
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
    if (server.transport !== 'stdio' && !server.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `url is required for the '${server.transport}' transport`,
        path: ['url'],
      });
    }
    if (server.url !== undefined) {
      // SSRF guard: a registered url must use the transport's scheme — reject file:, javascript:, etc.
      const schemeOk =
        server.transport === 'websocket'
          ? SAFE_WS_URL.test(server.url)
          : SAFE_HTTP_URL.test(server.url);
      if (!schemeOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'url scheme is invalid (http → http(s), websocket → ws(s))',
          path: ['url'],
        });
      }
      // Secret hygiene: no credentials embedded in a git-committed url.
      if (URL_HAS_CREDENTIALS.test(server.url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'url must not embed credentials (user:pass@…) — use env/keychain auth',
          path: ['url'],
        });
      }
    }
  });
export type McpServerRegistration = z.infer<typeof McpServerRegistrationSchema>;

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
    // Hard session **turn cap** — the surface-mapped form of the engine knob `SessionDeps.maxTurns`
    // (a finite DoS fail-safe; engine default 50, absent ⇒ that default). This config field is a
    // `positiveInt`, so 0 is rejected at parse and never reaches the engine's own `<= 0 ⇒ default` arm.
    // A `sendMessage` past the cap ends loudly (`session:turn_completed` `turn_limit`, no egress).
    // DISTINCT from `max_messages` (a history-**trim** threshold that silently continues) and the
    // within-turn `maxToolTurns` guard.
    max_turns: positiveInt.optional(),
    max_messages: positiveInt.optional(), // session-history cap before older turns are trimmed
    max_cost_microcents: nonNegativeInt.optional(), // 0/absent = unbounded; >0 = per-session cap
    on_exceed: z.enum(ON_EXCEED_ACTIONS).optional(),
  })
  .strict() // fail loud on an unknown [chat] key (strict config — ADR-0033, amends ADR-0023)
  .optional();

/**
 * Per-modality media-output **unit-count** default for the pre-egress media cost estimate (1.AF/D17,
 * [ADR-0044](../../../docs/decisions/0044-media-access-governance-read-media-save-to-cost.md) §3) — the analogue of
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
        // Async media-job (generateMedia LRO) poll cadence + deadline (1.AG/ADR-0045 §7). The engine
        // polls at `poll_initial_ms`, exponential-backs-off (no jitter) capped at `poll_max_ms`, and
        // abandons a job past `deadline_ms` (from submit) as a retryable timeout. Defaults: 5s / 30s / 30min.
        media_job_poll_initial_ms: positiveInt.optional(),
        media_job_poll_max_ms: positiveInt.optional(),
        media_job_deadline_ms: positiveInt.optional(),
        // Grace window (in DAYS) before a zero-reference media handle's CAS bytes are reclaimed by the host
        // media GC (ADR-0042 §4c). Absent ⇒ the built-in 7-day default (DEFAULT_MEDIA_GC_GRACE_MS).
        media_gc_grace_days: positiveInt.optional(),
      })
      .strict()
      .refine(
        (d) =>
          d.media_job_poll_max_ms === undefined ||
          d.media_job_poll_initial_ms === undefined ||
          d.media_job_poll_max_ms >= d.media_job_poll_initial_ms,
        {
          message: 'media_job_poll_max_ms must be >= media_job_poll_initial_ms',
          path: ['media_job_poll_max_ms'],
        },
      )
      .optional(),
    variables: z.record(z.string(), z.string()).optional(),
    chat: ChatConfigSchema,
    // Project-scoped MCP registrations merge with the global ones (config-spec.md §resolution).
    mcp_servers: z.array(McpServerRegistrationSchema).optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
