import type { FsScopeTier, ToolDef, ToolHost } from '@relavium/core';
import type { ToolPolicy } from '@relavium/shared';

import { createNodeFsCapability } from './fs.js';
import { createNodeProcessCapability } from './process.js';

/**
 * The shared CLI **tool-environment factory** ([ADR-0055](../../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md),
 * 2.5.A) — the single place both the chat path (`chat/session-host.ts`) and the workflow-run path
 * (`engine/build-engine.ts`) assemble their `ToolHost` capability arms + the chat-default `ToolPolicy`, so the
 * two paths can never drift (the prior bug was two divergent inline host expressions, one of which *replaced*
 * rather than *merged* the MCP arm). It keeps the three tool-dispatch concepts in three channels: the
 * {@link ToolHost} capability arms (here), the {@link ToolPolicy} allowlists (here for chat; the run path uses
 * the workflow's resolved policy per node), and the per-dispatch `fsScope` (carried on the dispatch context).
 *
 * **Phased wiring (2.5.A):** the chat profile is **read-only** (`fs` read+list, `process` serving the
 * pre-approved `git_status`); the run profile is **read+write** (the workflow-author trust model governs it).
 * The `egress` and `os` arms are **not** wired here — `egress` lands with [ADR-0057](../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)/2.5.E
 * behind the per-tool approval floor. The caller merges any inbound-MCP arm onto `host` with a conditional
 * spread (a true merge, never a replace).
 */

/** The two 2.5.A profiles: a read-only chat host vs the read+write workflow-run host. */
export type ToolEnvProfile = 'chat-read-only' | 'workflow-read-write';

export interface AssembleToolEnvOptions {
  readonly profile: ToolEnvProfile;
  /** The active filesystem scope tier (chat: `[chat].fs_scope` ?? sandboxed; run: the workflow's `fs_scope`). */
  readonly fsScopeTier: FsScopeTier;
  /** The session/run working directory (absolute) — the fs jail anchor and the process spawn cwd. */
  readonly workspaceDir: string;
  /** An optional extra sandboxed fs root (e.g. `~/.relavium/tmp/`); absent ⇒ workspace-only. */
  readonly tmpDir?: string;
}

export interface AssembledToolEnv {
  /** The capability arms (`fs` + `process`; `egress`/`os` deferred). The caller merges the MCP arm on top. */
  readonly host: ToolHost;
  /** The chat-default policy (empty allowlists). The run path overrides per node with the workflow policy. */
  readonly policy: ToolPolicy;
}

/** Assemble the `ToolHost` + chat-default `ToolPolicy` for a profile. Pure construction — no I/O here. */
export function assembleToolEnv(opts: AssembleToolEnvOptions): AssembledToolEnv {
  const readOnly = opts.profile === 'chat-read-only';
  // SECURITY: `full` is unjailed. Read-only does NOT neutralize it for chat — an unjailed READ can exfiltrate
  // `~/.ssh`, `~/.aws/credentials`, etc. back to the model/provider. So the lowest-trust surface (a chat
  // session, possibly a third-party `--agent`) is clamped to `project` (workspace-only); `full` stays
  // available to the author-trusted `workflow-read-write` profile. (Tracked: a 2.5.E approval-gated `full` chat.)
  const tier: FsScopeTier = readOnly && opts.fsScopeTier === 'full' ? 'project' : opts.fsScopeTier;
  const host: ToolHost = {
    fs: createNodeFsCapability({
      tier,
      workspaceDir: opts.workspaceDir,
      readOnly,
      ...(opts.tmpDir === undefined ? {} : { tmpDir: opts.tmpDir }),
    }),
    process: createNodeProcessCapability({ workspaceDir: opts.workspaceDir }),
    // egress / os are intentionally absent in 2.5.A (deferred to ADR-0057/2.5.E behind the approval floor).
  };
  // Chat default: empty allowedCommands ⇒ `run_command` denied; `git_status` is pre-approved and exposes no
  // model-controlled command, so an empty allowlist never blocks it (ADR-0055). NOTE: this is inert today —
  // the chat path relies on the `AgentSession` default `{}` and the run path uses the workflow's per-node
  // policy; the `{ host, policy }` shape is the ADR-0055 seam that 2.5.E/ADR-0057 populates with per-mode
  // allowlists. Pinned by the factory test so the chat default can't silently drift.
  const policy: ToolPolicy = {};
  return { host, policy };
}

/**
 * The **advertise-filter** (ADR-0055, 2.5.A): the subset of `grantedIds` whose required `ToolHost` capability
 * arm is actually wired in `host`, so an unwired tool is **never offered** to the model and the agent's
 * "say so plainly when a tool is unavailable" path applies. It is the best-effort complement to the
 * fail-closed dispatch backstop (`tool_unavailable`, EA1) — never a substitute for it. A granted id with no
 * matching `ToolDef` (a dynamically-registered tool resolved elsewhere) is kept; the registry still gates it.
 */
export function wiredToolIds(
  grantedIds: Iterable<string>,
  host: ToolHost,
  defs: readonly ToolDef[],
): string[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: string[] = [];
  for (const id of grantedIds) {
    const def = byId.get(id);
    if (def === undefined || requiredArmPresent(def, host)) out.push(id);
  }
  return out;
}

/**
 * Whether the `ToolHost` arm a tool needs is wired. The arm is the tool's TRANSPORT, which is not always its
 * `policy.egress` *kind*: a discovered MCP tool and the `mcp_call` built-in both route via `host.mcp` (the
 * `mcp` egress kind is a guardrail label, not the arm), while `http`/`search` egress route via `host.egress`.
 * An armless tool (os/delegate) is kept and left to the dispatch `tool_unavailable` backstop (EA1).
 */
function requiredArmPresent(def: ToolDef, host: ToolHost): boolean {
  if (def.source === 'mcp') return host.mcp !== undefined; // discovered MCP tools route via host.mcp
  if (def.policy.fsScoped) return host.fs !== undefined;
  if (def.policy.spawnsProcess) return host.process !== undefined;
  if (def.policy.egress === 'mcp') return host.mcp !== undefined; // the `mcp_call` built-in also uses host.mcp
  if (def.policy.egress !== undefined) return host.egress !== undefined; // `http` / `search` → host.egress
  // `os` (read_clipboard/notify → host.os) + delegate-backed tools (read_media → ctx.mediaRead, invoke_agent →
  // ctx.invokeAgent) carry no policy-class arm here: keep them and let the dispatch `tool_unavailable` backstop
  // (EA1) handle an absent arm/delegate — the filter is a best-effort complement, not a substitute.
  return true;
}
