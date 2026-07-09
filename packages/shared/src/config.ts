import { z } from 'zod';

import { URL_HAS_CREDENTIALS, nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import { FS_SCOPE_TIERS, ON_EXCEED_ACTIONS, REASONING_EFFORTS } from './constants.js';

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

/** The authored shape `McpServerRegistrationSchema.superRefine` validates (connection fields optional pre-refine). */
interface McpRegistrationDraft {
  name: string;
  transport: 'stdio' | 'http' | 'websocket' | 'sse';
  command?: string | undefined;
  args?: readonly string[] | undefined;
  autostart?: boolean | undefined;
  url?: string | undefined;
  env?: Record<string, string> | undefined;
  allow_local_endpoint?: boolean | undefined;
}

/** `stdio` registration: needs a `command`; rejects the network-only `url` / `allow_local_endpoint` so a committed
 *  registration's contract matches the inline `McpServerRefSchema` (a dead flag would also skew `serverFingerprint`). */
function validateStdioRegistration(server: McpRegistrationDraft, ctx: z.RefinementCtx): void {
  if (!server.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "command is required for the 'stdio' transport",
      path: ['command'],
    });
  }
  if (server.url !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "url is not used by the 'stdio' transport",
      path: ['url'],
    });
  }
  if (server.allow_local_endpoint !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "allow_local_endpoint is not used by the 'stdio' transport (network transports only)",
      path: ['allow_local_endpoint'],
    });
  }
}

/** Network registration (`http`/`websocket`): needs a scheme-checked, credential-free `url`; rejects `env` (no child
 *  process to inject into — 2.R wires `env` ONLY into a stdio spawn; network header-auth is a tracked follow-up). */
function validateNetworkRegistration(server: McpRegistrationDraft, ctx: z.RefinementCtx): void {
  if (!server.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `url is required for the '${server.transport}' transport`,
      path: ['url'],
    });
  }
  // Reject the stdio-only fields `command`/`args`/`env` on a network registration — symmetric with the inline
  // `McpServerRefSchema`; a network transport spawns no child, so they are inert (and would skew the fingerprint).
  for (const field of ['command', 'args', 'env'] as const) {
    if (server[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} is not used by a network transport — it applies only to a stdio server process${field === 'env' ? ' (network header-auth is a follow-up)' : ''}`,
        path: [field],
      });
    }
  }
  if (server.url !== undefined) {
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
    if (URL_HAS_CREDENTIALS.test(server.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url must not embed credentials (user:pass@…) — use env/keychain auth',
        path: ['url'],
      });
    }
  }
}

/**
 * An MCP server registration (`[[mcp_servers]]`). The transport dictates the required connection field:
 * `stdio` needs a `command`; `http` (Streamable HTTP) / `websocket` need a `url`; `sse` is the deprecated alias
 * of `http` (accepted for older servers, same `http(s)` url). Reconciled with the agent `McpServerRefSchema` to
 * one vocabulary — `stdio | http | websocket` (+ the `sse` alias)
 * ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §5).
 */
export const McpServerRegistrationSchema = z
  .object({
    name: nonEmptyString,
    transport: z.enum(['stdio', 'http', 'websocket', 'sse']),
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
    if (server.transport === 'stdio') validateStdioRegistration(server, ctx);
    else validateNetworkRegistration(server, ctx);
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
        // The GLOBAL default reasoning-effort tier (ADR-0066 §6) — the effort counterpart of `default_model`, the
        // write target of the `/models` picker's effort sub-step. Resolved BELOW project/workspace
        // `[chat].reasoning_effort` (config-spec.md), so a project override still wins; absent ⇒ the provider default.
        reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
        // Full-screen alt-screen renderer (2.6.F, ADR-0068 §e). The DEFAULT is ON for an interactive TTY, so this key
        // is the durable OPT-OUT: `false` (like the `--no-alt-screen` flag) keeps the byte-identical INLINE renderer
        // (native scrollback + the emulator's own a11y), the screen-reader fallback; `true` forces it on. The flag
        // overrides this key; a non-TTY / machine (`--json`/CI) path ignores both and always renders inline. The
        // transcript renders through a resize-tracked viewport with scroll-back + auto-follow (PgUp/PgDn,
        // Ctrl+Home/Ctrl+End) and mouse-wheel; only the `[`/`v` copy-and-search hatches remain (Step 5).
        alt_screen: z.boolean().optional(),
      })
      .strict()
      .optional(),
    mcp_servers: z.array(McpServerRegistrationSchema).optional(),
  })
  .strict();
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * Chat-mode (`[chat]`) defaults for the agent-first entry point (config-spec.md, ADR-0024).
 * Distinct from `[defaults]` (which governs workflow runs); a chat session may carry its own pre-egress cost cap
 * (`max_cost_microcents` + `on_exceed`) enforced by the same governor as a workflow budget (ADR-0028), and — since
 * 2.5.D ([ADR-0061](../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) — its own
 * `allowed_commands` / `allowed_command_globs` gating the `!`-shell escape (mapping to the engine's camelCase
 * `allowedCommands` / `allowedCommandGlobs`). **Empty/absent ⇒ `!`-shell is disabled** (the `empty ⇒ disabled`
 * symmetry security-review.md pins) — there is NO chat-specific relaxation of the command allowlist.
 */
export const ChatConfigSchema = z
  .object({
    default_model: z.string().optional(),
    fs_scope: FsScopeSchema.optional(),
    // `!`-shell allowlist (ADR-0061): exact full-command-string match (`allowed_commands`) + opt-in glob patterns
    // (`allowed_command_globs`, riskier). Both empty/absent ⇒ `!` denied (secure-by-default; the user opts in per
    // config-spec.md `[chat]`). Enforced by the SAME `enforcePolicy(allowedCommands)` the workflow run_command uses.
    allowed_commands: z.array(nonEmptyString).optional(),
    allowed_command_globs: z.array(nonEmptyString).optional(),
    // Hard session **turn cap** — the surface-mapped form of the engine knob `SessionDeps.maxTurns`
    // (a finite DoS fail-safe; engine default 50, absent ⇒ that default). This config field is a
    // `positiveInt`, so 0 is rejected at parse and never reaches the engine's own `<= 0 ⇒ default` arm.
    // A `sendMessage` past the cap ends loudly (`session:turn_completed` `turn_limit`, no egress).
    // DISTINCT from `max_messages` (a history-**trim** threshold that silently continues) and the
    // within-turn `maxToolTurns` guard.
    max_turns: positiveInt.optional(),
    max_messages: positiveInt.optional(), // history-trim threshold — consumed by `/trim` + auto-compaction (ADR-0062)
    // Automatic context compaction (ADR-0062). `auto_compact` gates the after-turn threshold check (absent ⇒
    // enabled — the read site applies `?? true`); `compact_threshold` is the fraction of the model's context
    // window that, once the last turn's real input tokens exceed it, triggers a compaction before the next
    // turn (absent ⇒ 0.8). A fraction in (0, 1].
    auto_compact: z.boolean().optional(),
    compact_threshold: z.number().gt(0).lte(1).optional(),
    max_cost_microcents: nonNegativeInt.optional(), // 0/absent = unbounded; >0 = per-session cap
    on_exceed: z.enum(ON_EXCEED_ACTIONS).optional(),
    // The default reasoning-effort tier for a chat whose bound agent authors none (ADR-0066) — off/low/medium/high/
    // max. Applied to the built-in default chat agent + surfaced as the picker's starting effort; only sent to a
    // reasoning-capable model. Absent ⇒ the provider default (no reasoning control sent).
    reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
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
