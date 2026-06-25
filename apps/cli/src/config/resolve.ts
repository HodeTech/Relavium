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
