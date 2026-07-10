import type { GlobalConfig, ProjectConfig } from '@relavium/shared';

/**
 * The **pure** config-resolution merge — no file IO, so it is unit-testable in isolation and
 * extractable to a shared package later (ADR-0048). Precedence is **last-writer-wins** across
 * the layers, per [config-spec.md](../../../../docs/reference/contracts/config-spec.md):
 * global → workspace → project (→ per-invocation, which carries no value-overriding flags in
 * Phase 1 and is therefore not yet a parameter). `workspace.toml` and `project.toml` share the
 * `ProjectConfigSchema`, so both arrive as `ProjectConfig`.
 */
type ProjectDefaults = NonNullable<ProjectConfig['defaults']>;
type FsScope = ProjectDefaults['fs_scope'];
type McpServerRegistration = NonNullable<GlobalConfig['mcp_servers']>[number];
type ChatConfig = NonNullable<ProjectConfig['chat']>;

/**
 * The resolved `[chat]` block — the agent-first chat entry point's defaults (config-spec.md, ADR-0024),
 * distinct from `[defaults]` (which governs workflow runs). Absent fields stay `undefined` so the chat
 * host falls back to its engine defaults (e.g. an absent `maxTurns` ⇒ `SessionDeps`'s built-in 50).
 */
export interface ResolvedChatConfig {
  /** `[chat].default_model` — the model a chat session binds when its agent names none. */
  readonly defaultModel: ChatConfig['default_model'];
  /** `[chat].fs_scope` — the filesystem permission tier for chat tool dispatch (same tiers as workflows). */
  readonly fsScope: ChatConfig['fs_scope'];
  /** `[chat].max_turns` — the hard session turn cap → `SessionDeps.maxTurns` (absent ⇒ engine default 50;
   *  a `positiveInt`, so 0 is rejected at the config layer, never reaching the engine's `<= 0 ⇒ default` arm);
   *  DISTINCT from `maxMessages` (a history-trim threshold) and the within-turn `maxToolTurns` guard. */
  readonly maxTurns: ChatConfig['max_turns'];
  /** `[chat].max_messages` — the history-trim threshold consumed by `/trim` + the auto-compaction failure
   *  fallback (→ `SessionDeps.maxMessages`; ADR-0062). */
  readonly maxMessages: ChatConfig['max_messages'];
  /** `[chat].auto_compact` — enable automatic context compaction (→ `SessionDeps.autoCompact`; absent ⇒ the
   *  engine default of enabled). ADR-0062. */
  readonly autoCompact: ChatConfig['auto_compact'];
  /** `[chat].compact_threshold` — the context-window fraction that triggers auto-compaction
   *  (→ `SessionDeps.compactThreshold`; absent ⇒ the engine default 0.8). ADR-0062. */
  readonly compactThreshold: ChatConfig['compact_threshold'];
  /** `[chat].max_cost_microcents` — per-session pre-egress cost cap (0/absent ⇒ unbounded; same ADR-0028 governor). */
  readonly maxCostMicrocents: ChatConfig['max_cost_microcents'];
  /** `[chat].on_exceed` — action when the cost cap trips (in an interactive REPL, `pause_for_approval`
   *  degrades to a loud turn-end since the prompt itself is the approval gate). */
  readonly onExceed: ChatConfig['on_exceed'];
  /** `[chat].allowed_commands` — the `!`-shell exact-match allowlist (→ engine `allowedCommands`; ADR-0061).
   *  Absent/empty ⇒ `!`-shell disabled (the `empty ⇒ disabled` symmetry; no chat-specific relaxation). */
  readonly allowedCommands: ChatConfig['allowed_commands'];
  /** `[chat].allowed_command_globs` — the opt-in glob form of the `!`-shell allowlist (→ `allowedCommandGlobs`). */
  readonly allowedCommandGlobs: ChatConfig['allowed_command_globs'];
  /** `[chat].reasoning_effort` — the default reasoning-effort tier for a chat whose agent authors none (ADR-0066).
   *  Applied to the built-in default chat agent (only sent to a reasoning-capable model). Absent ⇒ provider default. */
  readonly reasoningEffort: ChatConfig['reasoning_effort'];
}

export interface ResolvedConfig {
  readonly updateChannel: GlobalConfig['update_channel'];
  readonly defaultModel: string | undefined;
  readonly fsScope: FsScope;
  readonly maxTokensEstimate: number | undefined;
  /** `[defaults].media_cost_estimate` (2.S/D17, ADR-0044 §3) — per-modality output unit-count defaults for the
   *  pre-egress media-cost governor. Resolved last-writer-wins like the other defaults; absent ⇒ the engine's
   *  built-in unit estimate. (The per-unit price lives in the model catalog, never here.) */
  readonly mediaCostEstimate: ProjectDefaults['media_cost_estimate'];
  /** `[defaults].media_gc_grace_days` (2.S/D11, ADR-0042 §4c) normalized to **milliseconds** for the host media
   *  GC's grace window. Resolved last-writer-wins; absent ⇒ the GC's built-in `DEFAULT_MEDIA_GC_GRACE_MS` default. */
  readonly mediaGcGraceMs: number | undefined;
  /** The resolved `[chat]` block (agent-first chat defaults, ADR-0024) — see {@link ResolvedChatConfig}. */
  readonly chat: ResolvedChatConfig;
  /** `[preferences].alt_screen` (2.6.F, ADR-0068 §e) — the full-screen alt-screen renderer opt-in/out. A GLOBAL-only
   *  preference (no project/workspace layer — it is a per-user UX choice, not a per-repo default), so it reads
   *  straight from the global config. `undefined` ⇒ the phase default in `resolveRenderMode`. */
  readonly altScreen: boolean | undefined;
  /** `[preferences].mouse` (2.6.F Step 5e, ADR-0068 §e) — terminal mouse reporting inside the full-screen renderer.
   *  A GLOBAL-only preference for the same reason as {@link altScreen}. `undefined` ⇒ the phase default in
   *  `resolveMouseMode`. */
  readonly mouse: boolean | undefined;
  /** `[preferences].copy_on_select` (2.6.F Step 6e, ADR-0068 §e) — whether a released drag writes the selection to the
   *  system clipboard. A GLOBAL-only preference for the same reason as {@link mouse}. `undefined` ⇒ the phase default
   *  in `resolveCopyOnSelect`; meaningless (and ignored) when {@link mouse} is off. */
  readonly copyOnSelect: boolean | undefined;
  readonly variables: Readonly<Record<string, string>>;
  readonly mcpServers: readonly McpServerRegistration[];
}

/** ms per day — the host media GC's grace window is configured in days but threaded as ms. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ConfigLayers {
  readonly global?: GlobalConfig | undefined;
  readonly workspace?: ProjectConfig | undefined;
  readonly project?: ProjectConfig | undefined;
}

export function resolveConfig(layers: ConfigLayers): ResolvedConfig {
  const { global, workspace, project } = layers;
  return {
    updateChannel: global?.update_channel,
    defaultModel:
      project?.defaults?.model ?? workspace?.defaults?.model ?? global?.preferences?.default_model,
    fsScope: project?.defaults?.fs_scope ?? workspace?.defaults?.fs_scope,
    maxTokensEstimate:
      project?.defaults?.max_tokens_estimate ?? workspace?.defaults?.max_tokens_estimate,
    mediaCostEstimate:
      project?.defaults?.media_cost_estimate ?? workspace?.defaults?.media_cost_estimate,
    mediaGcGraceMs: resolveGraceMs(project, workspace),
    chat: resolveChat(project, workspace, global),
    altScreen: global?.preferences?.alt_screen,
    mouse: global?.preferences?.mouse,
    copyOnSelect: global?.preferences?.copy_on_select,
    variables: { ...workspace?.variables, ...project?.variables },
    mcpServers: mergeMcpServers(global?.mcp_servers, workspace?.mcp_servers, project?.mcp_servers),
  };
}

/**
 * Resolve `[defaults].media_gc_grace_days` (last-writer-wins: project → workspace) and normalize DAYS → ms.
 * Absent at every layer ⇒ `undefined`, so the host media GC falls back to its built-in `DEFAULT_MEDIA_GC_GRACE_MS`.
 */
function resolveGraceMs(
  project: ProjectConfig | undefined,
  workspace: ProjectConfig | undefined,
): number | undefined {
  const days = project?.defaults?.media_gc_grace_days ?? workspace?.defaults?.media_gc_grace_days;
  return days === undefined ? undefined : days * MS_PER_DAY;
}

/**
 * Resolve the `[chat]` block (last-writer-wins: project → workspace). Most fields are project/workspace-scoped
 * only; `default_model` AND `reasoning_effort` additionally fall back to their GLOBAL `[preferences]` counterparts
 * ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md) · ADR-0066 §6) — the write targets of
 * the `/models` picker (model + its effort sub-step) and the onboarding wizard — so a user's "preferred model /
 * effort everywhere" applies to chat when no project/workspace `[chat]` override wins, mirroring how the workflow
 * default (`resolveConfig.defaultModel`) already reads `[preferences].default_model`. Absent at every layer ⇒
 * all-`undefined` fields, so the chat host falls back to its engine defaults (e.g. `maxTurns` ⇒ `SessionDeps`'s 50).
 */
function resolveChat(
  project: ProjectConfig | undefined,
  workspace: ProjectConfig | undefined,
  global: GlobalConfig | undefined,
): ResolvedChatConfig {
  const p = project?.chat;
  const w = workspace?.chat;
  // The command allowlist is a COUPLED security policy: `allowed_commands` (exact) + `allowed_command_globs`
  // (patterns) together decide what `!`-shell may run. A project that sets EITHER owns the WHOLE policy and must
  // NOT inherit the other field from the workspace — else a project narrowing `allowed_commands` would silently
  // keep the workspace's broader globs (e.g. lock to `git status` yet still allow `git push` via an inherited
  // `git *`), the exact "narrower project can't inherit a broader workspace entry" the override guarantees
  // (ADR-0061). Only when the project sets NEITHER do both fall through to the workspace, per field.
  const projectSetsAllowlist =
    p?.allowed_commands !== undefined || p?.allowed_command_globs !== undefined;
  return {
    defaultModel: p?.default_model ?? w?.default_model ?? global?.preferences?.default_model,
    fsScope: p?.fs_scope ?? w?.fs_scope,
    maxTurns: p?.max_turns ?? w?.max_turns,
    maxMessages: p?.max_messages ?? w?.max_messages,
    autoCompact: p?.auto_compact ?? w?.auto_compact,
    compactThreshold: p?.compact_threshold ?? w?.compact_threshold,
    maxCostMicrocents: p?.max_cost_microcents ?? w?.max_cost_microcents,
    onExceed: p?.on_exceed ?? w?.on_exceed,
    allowedCommands: projectSetsAllowlist ? p?.allowed_commands : w?.allowed_commands,
    allowedCommandGlobs: projectSetsAllowlist ? p?.allowed_command_globs : w?.allowed_command_globs,
    reasoningEffort:
      p?.reasoning_effort ?? w?.reasoning_effort ?? global?.preferences?.reasoning_effort,
  };
}

/**
 * Concatenate MCP registrations across layers; a later layer overrides an earlier server with
 * the same `name` (last-writer-wins per setting), matching config-spec.md §resolution.
 */
function mergeMcpServers(
  ...lists: ReadonlyArray<readonly McpServerRegistration[] | undefined>
): readonly McpServerRegistration[] {
  const byName = new Map<string, McpServerRegistration>();
  for (const list of lists) {
    for (const server of list ?? []) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}
